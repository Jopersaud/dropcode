// Package transfer implements dropcode's sender and receiver for the CLI,
// following web/src/transfer.ts step for step so the two interoperate.
//
// Concurrency model: all state lives on one event-loop goroutine (like the
// browser's single thread). Signaling and link callbacks post closures to it;
// each peer link runs its protocol session on its own goroutine and touches
// shared state only through do().
package transfer

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/jopersaud/dropcode/cli/internal/auth"
	"github.com/jopersaud/dropcode/cli/internal/proto"
	"github.com/jopersaud/dropcode/cli/internal/rtc"
	"github.com/jopersaud/dropcode/cli/internal/signal"
)

// Error codes match the web client's.
type Error struct {
	Code string
	Msg  string
}

func (e *Error) Error() string {
	if m, ok := Messages[e.Code]; ok {
		return m
	}
	if e.Msg != "" {
		return e.Code + ": " + e.Msg
	}
	return e.Code
}

func errf(code, format string, a ...any) *Error { return &Error{Code: code, Msg: fmt.Sprintf(format, a...)} }

var Messages = map[string]string{
	"bad_code":          "that doesn't look like a dropcode (codes look like 4-apple-river)",
	"not_found":         "no transfer is waiting for that code",
	"expired":           "this code has expired; ask the sender for a new one",
	"used":              "this code was already used; codes only work once",
	"burned":            "too many wrong attempts, so this code was disabled",
	"room_full":         "someone else is already receiving with this code",
	"rate_limited":      "too many attempts from your network; wait a minute and try again",
	"peer_disconnected": "the other side disconnected",
	"cancelled_by_peer": "the other side cancelled the transfer",
	"hash_mismatch":     "the file arrived corrupted (checksum mismatch)",
	"auth_failed":       "couldn't verify the other side: the code may be wrong, or someone may be interfering",
	"connection_failed": "couldn't open a direct connection; a TURN relay may be needed on this network",
	"signaling_failed":  "lost the connection to the dropcode server",
}

var serverErrors = map[string]string{
	"not_found": "not_found", "expired": "expired", "used": "used", "burned": "burned",
	"room_full": "room_full", "rate_limited": "rate_limited", "auth_failed": "auth_failed", "auth_timeout": "auth_failed",
}

// UI receives progress for display. Calls come from the event loop.
type UI interface {
	Phase(p string)
	Code(code string, expiresAt time.Time)
	Meta(m proto.FileMeta)
	Progress(done, total int64)
	Notice(msg string)
}

var backoff = []time.Duration{250 * time.Millisecond, 500 * time.Millisecond, time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second}

type core struct {
	wsURL  string
	ui     UI
	ev     chan func()
	exited chan struct{}

	sig        *signal.Client
	ice        []webrtc.ICEServer
	link       *rtc.Link
	linkAuthed bool
	everAuthed bool
	roomDone   bool
	phase      string
	finished   bool
	result     error

	// hooks implemented by Sender / Receiver
	onServer        func(signal.ServerMessage)
	onSignalingLost func()
	onLinkFailed    func(reason string)
	onAuthFailed    func(*rtc.Link)
	role            auth.Role
}

func newCore(wsURL string, ui UI, role auth.Role) *core {
	return &core{wsURL: wsURL, ui: ui, ev: make(chan func(), 1024), exited: make(chan struct{}), phase: "connecting", role: role}
}

// post schedules f on the event loop without ever blocking the caller.
func (c *core) post(f func()) {
	select {
	case c.ev <- f:
	default:
		go func() { c.ev <- f }()
	}
}

// do runs f on the event loop and waits for it (session goroutines only).
// After the loop has exited, f is dropped.
func (c *core) do(f func()) {
	done := make(chan struct{})
	c.post(func() { f(); close(done) })
	select {
	case <-done:
	case <-c.exited:
	}
}

func (c *core) loop(ctx context.Context) error {
	defer close(c.exited)
	for !c.finished {
		select {
		case f := <-c.ev:
			f()
		case <-ctx.Done():
			c.post(func() {}) // wake
			return ctx.Err()
		}
	}
	return c.result
}

func (c *core) setPhase(p string) {
	if c.finished || p == c.phase {
		return
	}
	c.phase = p
	c.ui.Phase(p)
}

func (c *core) fail(err error) {
	if c.finished {
		return
	}
	c.result = err
	c.finished = true
	c.teardown()
}

func (c *core) succeed() {
	if c.finished {
		return
	}
	c.phase = "done"
	c.ui.Phase("done")
	c.finished = true
	link, sig := c.link, c.sig
	c.link, c.sig = nil, nil
	go func() {
		if link != nil {
			link.Flush(2 * time.Second)
			time.Sleep(200 * time.Millisecond)
			link.Close()
		}
		if sig != nil {
			sig.Close()
		}
	}()
}

func (c *core) teardown() {
	c.dropLink()
	if c.sig != nil {
		c.sig.Close()
		c.sig = nil
	}
}

func (c *core) dropLink() {
	if c.link != nil {
		c.link.Close()
	}
	c.link = nil
	c.linkAuthed = false
}

func (c *core) linkHealthy() bool {
	if c.link == nil || !c.linkAuthed {
		return false
	}
	select {
	case <-c.link.Done:
		return false
	default:
		return true
	}
}

func (c *core) sendServer(m any) {
	if c.sig != nil {
		_ = c.sig.Send(m)
	}
}

// openSignaling dials the server (blocking; call from a goroutine) and wires
// the new client into the loop.
func (c *core) openSignaling(ctx context.Context) (*signal.Client, error) {
	sig, err := signal.Dial(ctx, c.wsURL)
	if err != nil {
		return nil, &Error{Code: "signaling_failed", Msg: err.Error()}
	}
	c.do(func() {
		if c.sig != nil {
			c.sig.Close()
		}
		c.sig = sig
		c.ice = sig.Hello.IceServers
	})
	go func() {
		for m := range sig.Msgs {
			c.post(func() {
				if c.sig == sig && !c.finished {
					c.onServer(m)
				}
			})
		}
		c.post(func() {
			if c.sig != sig {
				return
			}
			c.sig = nil
			if !c.finished && !c.roomDone {
				c.onSignalingLost()
			}
		})
	}()
	return sig, nil
}

func (c *core) serverError(code string) {
	if mapped, ok := serverErrors[code]; ok {
		c.fail(&Error{Code: mapped})
	} else {
		c.fail(&Error{Code: "protocol", Msg: code})
	}
}

func (c *core) onClosed(reason string) {
	switch reason {
	case "done":
		c.roomDone = true
	case "cancelled":
		c.fail(&Error{Code: "cancelled_by_peer"})
	case "expired":
		c.fail(&Error{Code: "expired"})
	case "burned":
		c.fail(&Error{Code: "burned"})
	default:
		c.fail(&Error{Code: "peer_disconnected"})
	}
}

func (c *core) newLink(initiator bool, session func(*rtc.Link) error) (*rtc.Link, error) {
	c.dropLink()
	link, err := rtc.New(c.ice, func(d signal.SignalData) {
		c.post(func() { c.sendServer(map[string]any{"t": "signal", "data": d}) })
	}, initiator)
	if err != nil {
		return nil, err
	}
	c.link = link
	c.setPhase("connecting-peer")
	go func() {
		select {
		case <-link.Opened:
			go c.runGuarded(link, session)
		case <-link.Done:
		}
		<-link.Done
		c.post(func() {
			if c.link == link && !c.finished {
				c.onLinkFailed(link.Reason)
			}
		})
	}()
	return link, nil
}

// reader yields one link's frames as parsed control messages or binary data.
type reader struct {
	c    *core
	link *rtc.Link
}

var errBinary = errors.New("binary frame")

// next returns the next control message; binary frames go to onBinary.
func (r reader) next(ctx context.Context, onBinary func([]byte) error) (*proto.Message, error) {
	for {
		select {
		case f := <-r.link.Inbox:
			if !f.IsString {
				if onBinary == nil {
					return nil, errf("protocol", "unexpected binary frame")
				}
				if err := onBinary(f.Data); err != nil {
					return nil, err
				}
				continue
			}
			m, err := proto.Parse(f.Data)
			if err != nil {
				return nil, errf("protocol", "malformed peer message")
			}
			if m.T == "cancel" {
				return nil, &Error{Code: "cancelled_by_peer"}
			}
			return m, nil
		case <-r.link.Done:
			return nil, &Error{Code: "peer_disconnected", Msg: r.link.Reason}
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

func (r reader) expect(ctx context.Context, t string, onBinary func([]byte) error) (*proto.Message, error) {
	m, err := r.next(ctx, onBinary)
	if err != nil {
		return nil, err
	}
	if m.T != t {
		return nil, errf("protocol", "expected %s, got %s", t, m.T)
	}
	return m, nil
}

type authChannel struct{ r reader }

func (a authChannel) Send(b []byte) error { return a.r.link.SendText(b) }
func (a authChannel) Recv(ctx context.Context, t string) (*proto.Message, error) {
	return a.r.expect(ctx, t, nil)
}

// handshake: version check (sender speaks first, see DECISIONS.md), then
// SPAKE2 with fingerprint-bound key confirmation.
func (c *core) handshake(ctx context.Context, link *rtc.Link, r reader, code string) error {
	if c.role == auth.Sender {
		if err := link.SendText(proto.Hello()); err != nil {
			return &Error{Code: "peer_disconnected"}
		}
	}
	hello, err := r.expect(ctx, "hello", nil)
	if err != nil {
		return err
	}
	if c.role == auth.Receiver {
		if err := link.SendText(proto.Hello()); err != nil {
			return &Error{Code: "peer_disconnected"}
		}
	}
	if hello.V != proto.Version {
		return errf("protocol", "version mismatch")
	}
	c.do(func() { c.setPhase("authenticating") })
	actx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	if err := auth.Authenticate(actx, c.role, code, link.LocalSDP(), link.RemoteSDP(), authChannel{r}); err != nil {
		var te *Error
		if errors.As(err, &te) && te.Code == "cancelled_by_peer" {
			return err
		}
		return &Error{Code: "auth_failed", Msg: err.Error()}
	}
	c.do(func() {
		if c.link == link {
			c.linkAuthed = true
			c.everAuthed = true
		}
	})
	return nil
}

func (c *core) runGuarded(link *rtc.Link, session func(*rtc.Link) error) {
	if err := session(link); err != nil {
		c.do(func() { c.sessionError(link, err) })
	}
}

// sessionError routes an error that ended a session (called on the loop).
func (c *core) sessionError(link *rtc.Link, err error) {
	if c.link != link || c.finished {
		return
	}
	var te *Error
	if !errors.As(err, &te) {
		te = &Error{Code: "protocol", Msg: err.Error()}
	}
	switch te.Code {
	case "peer_disconnected":
		c.onLinkFailed("channel closed")
	case "auth_failed":
		c.onAuthFailed(link)
	default:
		if te.Code == "protocol" || (te.Code == "hash_mismatch" && c.role == auth.Sender) {
			c.sendServer(map[string]string{"t": "cancel"})
		}
		c.fail(te)
	}
}

// Cancel aborts the transfer and spends the code.
func (c *core) Cancel() {
	c.do(func() {
		if c.finished {
			return
		}
		if c.link != nil {
			_ = c.link.SendText(proto.Simple("cancel"))
		}
		c.sendServer(map[string]string{"t": "cancel"})
		c.result = &Error{Code: "cancelled"}
		c.finished = true
		link, sig := c.link, c.sig
		c.link, c.sig = nil, nil
		go func() {
			time.Sleep(300 * time.Millisecond)
			if link != nil {
				link.Close()
			}
			if sig != nil {
				sig.Close()
			}
		}()
	})
}
