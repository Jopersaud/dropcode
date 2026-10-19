package transfer

import (
	"context"
	"fmt"
	"time"

	"github.com/jopersaud/dropcode/cli/internal/auth"
	"github.com/jopersaud/dropcode/cli/internal/proto"
	"github.com/jopersaud/dropcode/cli/internal/rtc"
	"github.com/jopersaud/dropcode/cli/internal/signal"
	"github.com/jopersaud/dropcode/cli/internal/words"
)

var sprintf = fmt.Sprintf

type Receiver struct {
	*core
	code      words.Code
	dir       string
	ctx       context.Context
	part      *partFile // owned by the active session goroutine
	meta      *proto.FileMeta
	rejoining bool

	// Path is the saved file after a successful transfer.
	Path string
	// Resumed is how many chunks were already on disk when a session began.
	Resumed []int64
}

func NewReceiver(wsURL, code, dir string, ui UI) (*Receiver, error) {
	c, err := words.Parse(code)
	if err != nil {
		return nil, &Error{Code: "bad_code"}
	}
	r := &Receiver{core: newCore(wsURL, ui, auth.Receiver), code: c, dir: dir}
	r.onServer = r.handleServer
	r.onSignalingLost = r.signalingLost
	r.onLinkFailed = r.linkFailed
	r.onAuthFailed = func(*rtc.Link) { r.fail(&Error{Code: "auth_failed"}) }
	return r, nil
}

func (r *Receiver) Run(ctx context.Context) error {
	r.ctx = ctx
	go func() {
		if err := r.join(); err != nil {
			r.post(func() { r.fail(err) })
		}
	}()
	err := r.loop(ctx)
	// Persist progress on any exit so a later run can resume.
	if r.part != nil && r.Path == "" {
		r.part.Close()
	}
	return err
}

func (r *Receiver) join() error {
	if _, err := r.openSignaling(r.ctx); err != nil {
		return err
	}
	r.post(func() { r.sendServer(map[string]string{"t": "join", "nameplate": r.code.Nameplate}) })
	return nil
}

func (r *Receiver) handleServer(m signal.ServerMessage) {
	switch m.T {
	case "joined":
		if !r.everAuthed {
			r.setPhase("connecting-peer")
		}
	case "signal":
		if m.Data == nil {
			return
		}
		if m.Data.Kind == "offer" {
			if _, err := r.newLink(false, r.session); err != nil {
				r.fail(err)
				return
			}
		}
		if r.link != nil {
			link, d := r.link, *m.Data
			go link.HandleSignal(d)
		}
	case "peer_left":
		// The sender's signaling dropped; it may reclaim the room.
	case "closed":
		r.onClosed(m.Reason)
	case "error":
		if m.Code == "room_full" && r.rejoining {
			return
		}
		r.serverError(m.Code)
	}
}

func (r *Receiver) signalingLost() {
	if r.linkHealthy() {
		return
	}
	if r.everAuthed {
		r.rejoin()
	} else {
		r.fail(&Error{Code: "signaling_failed"})
	}
}

func (r *Receiver) linkFailed(reason string) {
	if r.link == nil {
		return
	}
	phase := r.phase
	r.dropLink()
	if r.everAuthed {
		r.setPhase("reconnecting")
		r.rejoin()
		return
	}
	switch {
	case phase == "authenticating":
		r.fail(&Error{Code: "auth_failed", Msg: reason})
	case reason == "timeout":
		r.fail(&Error{Code: "connection_failed"})
	default:
		r.fail(&Error{Code: "peer_disconnected", Msg: reason})
	}
}

// rejoin re-enters the room with the same code; the sender re-offers.
func (r *Receiver) rejoin() {
	if r.rejoining {
		return
	}
	r.rejoining = true
	go func() {
		defer r.post(func() { r.rejoining = false })
		for _, d := range append(append([]time.Duration{}, backoff...), 8*time.Second, 8*time.Second, 8*time.Second) {
			stop := false
			r.do(func() {
				stop = r.finished || r.linkHealthy()
				if !stop && r.sig != nil {
					old := r.sig
					r.sig = nil
					old.Close()
				}
			})
			if stop {
				return
			}
			time.Sleep(d)
			if r.join() == nil {
				time.Sleep(10 * time.Second)
				linked := false
				r.do(func() { linked = r.link != nil || r.finished })
				if linked {
					return
				}
			}
		}
		r.post(func() { r.fail(&Error{Code: "peer_disconnected"}) })
	}()
}

func (r *Receiver) session(link *rtc.Link) error {
	ctx := r.ctx
	rd := reader{c: r.core, link: link}
	if err := r.handshake(ctx, link, rd, r.code.String()); err != nil {
		return err
	}
	mm, err := rd.expect(ctx, "meta", nil)
	if err != nil {
		return err
	}
	meta := mm.Meta
	if r.meta != nil && (r.meta.SHA256 != meta.SHA256 || r.meta.Size != meta.Size) {
		return errf("protocol", "file changed between sessions")
	}
	if r.part == nil {
		part, err := openPart(r.dir, meta)
		if err != nil {
			return errf("protocol", "cannot write output: %v", err)
		}
		r.part = part
		r.meta = &meta
		r.do(func() { r.ui.Meta(meta) })
	}
	part := r.part
	have := part.Have()
	missing := proto.Missing(have, proto.ChunkCount(meta.Size))
	r.Resumed = append(r.Resumed, have.Count())
	if part.count > 0 {
		b := part.bytes
		r.do(func() { r.ui.Notice(sprintf("resuming: %d of %d bytes already downloaded", b, meta.Size)) })
	}
	if err := link.SendText(proto.Resume(have)); err != nil {
		return &Error{Code: "peer_disconnected"}
	}
	r.do(func() {
		r.setPhase("transferring")
		r.ui.Progress(part.bytes, meta.Size)
	})

	// Chunks arrive in ascending order over the missing ranges.
	ri, next := 0, int64(0)
	if len(missing) > 0 {
		next = missing[0][0]
	}
	lastReport, lastCheckpoint := time.Now(), time.Now()
	onBinary := func(data []byte) error {
		if ri >= len(missing) {
			return errf("protocol", "unexpected chunk")
		}
		if err := part.Write(next, data); err != nil {
			return errf("protocol", "chunk %d: %v", next, err)
		}
		next++
		for ri < len(missing) && next >= missing[ri][1] {
			ri++
			if ri < len(missing) {
				next = missing[ri][0]
			}
		}
		if time.Since(lastReport) > 200*time.Millisecond {
			lastReport = time.Now()
			b := part.bytes
			r.post(func() { r.ui.Progress(b, meta.Size) })
		}
		if time.Since(lastCheckpoint) > 2*time.Second {
			lastCheckpoint = time.Now()
			_ = part.Checkpoint()
		}
		return nil
	}
	if _, err := rd.expect(ctx, "eof", onBinary); err != nil {
		_ = part.Checkpoint()
		return err
	}
	if ri < len(missing) || !part.Complete() {
		return errf("protocol", "eof before all chunks")
	}
	r.do(func() {
		r.ui.Progress(meta.Size, meta.Size)
		r.setPhase("verifying")
	})
	ok, err := part.Verify()
	if err != nil {
		return errf("protocol", "verifying: %v", err)
	}
	if !ok {
		_ = link.SendText(proto.Simple("hash_mismatch"))
		part.Discard()
		r.part = nil
		return &Error{Code: "hash_mismatch"}
	}
	path, err := part.Finish()
	if err != nil {
		return errf("protocol", "saving file: %v", err)
	}
	r.Path = path
	_ = link.SendText(proto.Simple("ok"))
	r.do(func() {
		r.sendServer(map[string]string{"t": "done"})
		r.succeed()
	})
	return nil
}
