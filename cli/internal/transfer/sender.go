package transfer

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"mime"
	"os"
	"path/filepath"
	"time"

	"github.com/jopersaud/dropcode/cli/internal/auth"
	"github.com/jopersaud/dropcode/cli/internal/proto"
	"github.com/jopersaud/dropcode/cli/internal/rtc"
	"github.com/jopersaud/dropcode/cli/internal/signal"
	"github.com/jopersaud/dropcode/cli/internal/words"
)

type Sender struct {
	*core
	file      *os.File
	size      int64
	name      string
	words     [2]string
	code      string
	nameplate string
	token     string
	meta      chan proto.FileMeta // closed once hashing completes (holds the value)
	metaVal   proto.FileMeta
	hashErr   error
	failures  int
	reclaimig bool
	ctx       context.Context

	ChunksSent int64
	Sessions   []int64 // chunks skipped by each session
}

func NewSender(wsURL, path string, ui UI) (*Sender, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() {
		f.Close()
		return nil, errf("protocol", "%s is not a regular file", path)
	}
	s := &Sender{
		core: newCore(wsURL, ui, auth.Sender), file: f, size: st.Size(),
		name: proto.SanitizeName(filepath.Base(path)), words: words.RandomWords(),
		meta: make(chan proto.FileMeta),
	}
	s.onServer = s.handleServer
	s.onSignalingLost = s.signalingLost
	s.onLinkFailed = s.linkFailed
	s.onAuthFailed = s.rejectPeer
	return s, nil
}

func (s *Sender) Close() { s.file.Close() }

// Run drives the transfer until it completes, fails or ctx is cancelled.
func (s *Sender) Run(ctx context.Context) error {
	s.ctx = ctx
	go s.hash()
	go func() {
		if _, err := s.openSignaling(ctx); err != nil {
			s.post(func() { s.fail(err) })
			return
		}
		s.post(func() { s.sendServer(map[string]string{"t": "create"}) })
	}()
	return s.loop(ctx)
}

func (s *Sender) hash() {
	h := sha256.New()
	if _, err := io.Copy(h, io.NewSectionReader(s.file, 0, s.size)); err != nil {
		s.hashErr = err
		close(s.meta)
		return
	}
	mt := mime.TypeByExtension(filepath.Ext(s.name))
	if i := len(mt); i > 0 {
		if j := indexByte(mt, ';'); j >= 0 {
			mt = mt[:j]
		}
	}
	s.metaVal = proto.FileMeta{Name: s.name, Size: s.size, Mime: proto.ValidMime(mt), SHA256: hex.EncodeToString(h.Sum(nil)), ChunkSize: proto.ChunkSize}
	close(s.meta)
}

func indexByte(s string, b byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == b {
			return i
		}
	}
	return -1
}

func (s *Sender) idlePhase() string {
	if s.everAuthed {
		return "reconnecting"
	}
	return "waiting"
}

func (s *Sender) handleServer(m signal.ServerMessage) {
	switch m.T {
	case "created":
		s.nameplate, s.token = m.Nameplate, m.Token
		s.code = words.Code{Nameplate: m.Nameplate, Words: s.words}.String()
		s.ui.Code(s.code, time.UnixMilli(m.ExpiresAt))
		s.setPhase("waiting")
	case "reclaimed":
		if m.ReceiverPresent && !s.linkHealthy() {
			s.startLink()
		}
	case "peer_joined":
		s.startLink()
	case "peer_left":
		if s.link != nil && !s.linkHealthy() {
			s.linkFailed("peer left")
		}
	case "signal":
		if s.link != nil && m.Data != nil {
			link, d := s.link, *m.Data
			go link.HandleSignal(d)
		}
	case "closed":
		s.onClosed(m.Reason)
	case "error":
		if s.linkHealthy() && (m.Code == "not_found" || m.Code == "expired") {
			return // failed reclaim; we can still finish over the current link
		}
		s.serverError(m.Code)
	}
}

func (s *Sender) startLink() {
	link, err := s.newLink(true, s.session)
	if err != nil {
		s.fail(err)
		return
	}
	go func() {
		if err := link.Start(); err != nil {
			s.post(func() {
				if s.link == link {
					s.linkFailed("negotiation failed")
				}
			})
		}
	}()
}

func (s *Sender) signalingLost() {
	if s.nameplate == "" {
		s.fail(&Error{Code: "signaling_failed"})
		return
	}
	if !s.linkHealthy() {
		s.dropLink()
		s.setPhase("reconnecting")
	}
	if s.reclaimig {
		return
	}
	s.reclaimig = true
	go func() {
		defer s.post(func() { s.reclaimig = false })
		for _, d := range backoff {
			time.Sleep(d)
			done := false
			s.do(func() { done = s.finished })
			if done {
				return
			}
			if _, err := s.openSignaling(s.ctx); err == nil {
				s.post(func() {
					s.sendServer(map[string]string{"t": "reclaim", "nameplate": s.nameplate, "token": s.token})
				})
				return
			}
		}
		s.post(func() {
			if !s.linkHealthy() {
				s.fail(&Error{Code: "signaling_failed"})
			}
		})
	}()
}

func (s *Sender) linkFailed(reason string) {
	link := s.link
	if link == nil {
		return
	}
	if s.phase == "authenticating" {
		s.rejectPeer(link)
		return
	}
	neverConnected := s.phase == "connecting-peer"
	s.dropLink()
	switch {
	case neverConnected && !s.everAuthed:
		s.ui.Notice("a receiver tried to connect but no direct connection could be made; still waiting")
		s.setPhase("waiting")
	case s.everAuthed:
		s.setPhase("reconnecting")
	default:
		code := "peer_disconnected"
		if reason == "timeout" {
			code = "connection_failed"
		}
		s.fail(&Error{Code: code, Msg: reason})
	}
}

// rejectPeer: the receiver failed key confirmation; report it and keep waiting.
func (s *Sender) rejectPeer(link *rtc.Link) {
	if s.link != link || s.finished {
		return
	}
	s.dropLink()
	s.failures++
	s.sendServer(map[string]string{"t": "auth_failed"})
	s.ui.Notice(sprintf("someone connected with the wrong code and was rejected (%d of 3 attempts); still waiting", s.failures))
	s.setPhase(s.idlePhase())
}

func (s *Sender) session(link *rtc.Link) error {
	ctx := s.ctx
	r := reader{c: s.core, link: link}
	var code string
	s.do(func() { code = s.code })
	if err := s.handshake(ctx, link, r, code); err != nil {
		return err
	}
	s.do(func() { s.sendServer(map[string]string{"t": "authed"}) })

	select {
	case <-s.meta:
	case <-link.Done:
		return &Error{Code: "peer_disconnected"}
	}
	if s.hashErr != nil {
		return errf("protocol", "reading file: %v", s.hashErr)
	}
	meta := s.metaVal
	if err := link.SendText(proto.Meta(meta)); err != nil {
		return &Error{Code: "peer_disconnected"}
	}
	total := proto.ChunkCount(meta.Size)
	res, err := r.expect(ctx, "resume", nil)
	if err != nil {
		return err
	}
	if err := proto.CheckRanges(res.Have, total); err != nil {
		return errf("protocol", "%v", err)
	}
	missing := proto.Missing(res.Have, total)
	s.do(func() {
		s.Sessions = append(s.Sessions, res.Have.Count())
		s.setPhase("transferring")
	})
	if err := s.stream(ctx, link, meta, missing, total-missing.Count()); err != nil {
		return err
	}
	if err := link.SendText(proto.Simple("eof")); err != nil {
		return &Error{Code: "peer_disconnected"}
	}
	s.do(func() { s.setPhase("verifying") })
	m, err := r.next(ctx, nil)
	if err != nil {
		return err
	}
	switch m.T {
	case "ok":
		s.do(func() {
			s.sendServer(map[string]string{"t": "done"})
			s.ui.Progress(meta.Size, meta.Size)
			s.succeed()
		})
		return nil
	case "hash_mismatch":
		return &Error{Code: "hash_mismatch"}
	default:
		return errf("protocol", "unexpected %s", m.T)
	}
}

func (s *Sender) stream(ctx context.Context, link *rtc.Link, meta proto.FileMeta, ranges proto.Ranges, had int64) error {
	sent := min(had*proto.ChunkSize, meta.Size)
	last := time.Time{}
	report := func(force bool) {
		if force || time.Since(last) > 200*time.Millisecond {
			last = time.Now()
			done := max(0, sent-int64(link.BufferedAmount()))
			s.post(func() { s.ui.Progress(done, meta.Size) })
		}
	}
	defer report(true)
	for _, rg := range ranges {
		for i := rg[0]; i < rg[1]; i++ {
			if err := link.WaitDrain(ctx); err != nil {
				return &Error{Code: "peer_disconnected"}
			}
			off := i * proto.ChunkSize
			n := min(int64(proto.ChunkSize), meta.Size-off)
			buf := make([]byte, n)
			if _, err := s.file.ReadAt(buf, off); err != nil && err != io.EOF {
				return errf("protocol", "reading file: %v", err)
			}
			if err := link.SendBinary(buf); err != nil {
				return &Error{Code: "peer_disconnected"}
			}
			sent += n
			s.ChunksSent++
			report(false)
		}
	}
	return nil
}
