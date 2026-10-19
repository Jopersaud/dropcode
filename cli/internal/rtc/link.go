// Package rtc wraps one pion PeerConnection + data channel attempt, mirroring
// web/src/rtc.ts: the sender is the offerer and creates a single ordered,
// reliable channel named "dropcode".
package rtc

import (
	"context"
	"errors"
	"os"
	"sync"
	"time"

	"github.com/pion/logging"
	"github.com/pion/webrtc/v4"

	"github.com/jopersaud/dropcode/cli/internal/signal"
)

const (
	BufferLow      = 1 << 20
	BufferHigh     = 4 << 20
	connectTimeout = 30 * time.Second
	inboxSize      = 256
)

var ErrClosed = errors.New("peer link closed")

// Frame is one data-channel message.
type Frame struct {
	Data     []byte
	IsString bool
}

type Link struct {
	ID        int
	pc        *webrtc.PeerConnection
	dc        *webrtc.DataChannel
	initiator bool
	signal    func(signal.SignalData)

	// Inbox delivers frames in order. Blocking here pushes back on the sender.
	Inbox chan Frame
	// Opened is closed when the data channel opens.
	Opened chan struct{}
	// Done is closed when the link fails or is closed; Reason says why.
	Done   chan struct{}
	Reason string

	mu        sync.Mutex
	pending   []webrtc.ICECandidateInit
	closed    bool
	openOnce  sync.Once
	low       chan struct{}
	discTimer *time.Timer
}

var nextID = 1
var idMu sync.Mutex

var (
	apiOnce sync.Once
	api     *webrtc.API
)

// pion logs to stderr by default; keep it quiet unless DROPCODE_DEBUG is set.
func getAPI() *webrtc.API {
	apiOnce.Do(func() {
		var se webrtc.SettingEngine
		lf := logging.NewDefaultLoggerFactory()
		lf.DefaultLogLevel = logging.LogLevelDisabled
		if os.Getenv("DROPCODE_DEBUG") != "" {
			lf.DefaultLogLevel = logging.LogLevelWarn
		}
		se.LoggerFactory = lf
		api = webrtc.NewAPI(webrtc.WithSettingEngine(se))
	})
	return api
}

func New(iceServers []webrtc.ICEServer, relayOnly bool, sendSignal func(signal.SignalData), initiator bool) (*Link, error) {
	cfg := webrtc.Configuration{ICEServers: iceServers}
	if relayOnly {
		cfg.ICETransportPolicy = webrtc.ICETransportPolicyRelay
	}
	pc, err := getAPI().NewPeerConnection(cfg)
	if err != nil {
		return nil, err
	}
	idMu.Lock()
	id := nextID
	nextID++
	idMu.Unlock()
	l := &Link{
		ID: id, pc: pc, initiator: initiator, signal: sendSignal,
		Inbox: make(chan Frame, inboxSize), Opened: make(chan struct{}), Done: make(chan struct{}),
		low: make(chan struct{}, 1),
	}
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			l.send(signal.SignalData{Kind: "end-of-candidates"})
			return
		}
		init := c.ToJSON()
		l.send(signal.SignalData{Kind: "candidate", Candidate: &init})
	})
	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		switch s {
		case webrtc.PeerConnectionStateFailed:
			l.fail("connection failed")
		case webrtc.PeerConnectionStateClosed:
			l.fail("connection closed")
		case webrtc.PeerConnectionStateDisconnected:
			l.mu.Lock()
			if l.discTimer != nil {
				l.discTimer.Stop()
			}
			l.discTimer = time.AfterFunc(5*time.Second, func() {
				if pc.ConnectionState() == webrtc.PeerConnectionStateDisconnected {
					l.fail("connection lost")
				}
			})
			l.mu.Unlock()
		}
	})
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		l.mu.Lock()
		taken := l.initiator || l.dc != nil
		l.mu.Unlock()
		if taken {
			_ = dc.Close()
			return
		}
		l.setup(dc)
	})
	time.AfterFunc(connectTimeout, func() {
		select {
		case <-l.Opened:
		default:
			l.fail("timeout")
		}
	})
	return l, nil
}

func (l *Link) send(d signal.SignalData) {
	l.mu.Lock()
	closed := l.closed
	l.mu.Unlock()
	if !closed {
		l.signal(d)
	}
}

func (l *Link) setup(dc *webrtc.DataChannel) {
	l.mu.Lock()
	l.dc = dc
	l.mu.Unlock()
	dc.SetBufferedAmountLowThreshold(BufferLow)
	dc.OnBufferedAmountLow(func() {
		select {
		case l.low <- struct{}{}:
		default:
		}
	})
	dc.OnOpen(func() { l.openOnce.Do(func() { close(l.Opened) }) })
	// Attached at creation, so nothing that arrives early is lost.
	dc.OnMessage(func(m webrtc.DataChannelMessage) {
		select {
		case l.Inbox <- Frame{Data: m.Data, IsString: m.IsString}:
		case <-l.Done:
		}
	})
	dc.OnClose(func() { l.fail("channel closed") })
	dc.OnError(func(error) { l.fail("channel error") })
}

// Start creates the channel and offer (initiator only).
func (l *Link) Start() error {
	if !l.initiator {
		return nil
	}
	ordered := true
	dc, err := l.pc.CreateDataChannel("dropcode", &webrtc.DataChannelInit{Ordered: &ordered})
	if err != nil {
		return err
	}
	l.setup(dc)
	offer, err := l.pc.CreateOffer(nil)
	if err != nil {
		return err
	}
	if err := l.pc.SetLocalDescription(offer); err != nil {
		return err
	}
	l.send(signal.SignalData{Kind: "offer", SDP: l.pc.LocalDescription().SDP})
	return nil
}

func (l *Link) HandleSignal(d signal.SignalData) {
	if l.isClosed() {
		return
	}
	var err error
	switch {
	case d.Kind == "offer" && !l.initiator:
		if err = l.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: d.SDP}); err != nil {
			break
		}
		l.flush()
		var answer webrtc.SessionDescription
		if answer, err = l.pc.CreateAnswer(nil); err != nil {
			break
		}
		if err = l.pc.SetLocalDescription(answer); err != nil {
			break
		}
		l.send(signal.SignalData{Kind: "answer", SDP: l.pc.LocalDescription().SDP})
	case d.Kind == "answer" && l.initiator:
		if err = l.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: d.SDP}); err == nil {
			l.flush()
		}
	case d.Kind == "candidate" && d.Candidate != nil:
		if l.pc.RemoteDescription() != nil {
			_ = l.pc.AddICECandidate(*d.Candidate)
		} else {
			l.mu.Lock()
			if len(l.pending) < 256 {
				l.pending = append(l.pending, *d.Candidate)
			}
			l.mu.Unlock()
		}
	}
	if err != nil {
		l.fail("negotiation failed")
	}
}

func (l *Link) flush() {
	l.mu.Lock()
	p := l.pending
	l.pending = nil
	l.mu.Unlock()
	for _, c := range p {
		_ = l.pc.AddICECandidate(c)
	}
}

func (l *Link) LocalSDP() string  { return l.pc.LocalDescription().SDP }
func (l *Link) RemoteSDP() string { return l.pc.RemoteDescription().SDP }

func (l *Link) SendText(b []byte) error {
	if l.isClosed() {
		return ErrClosed
	}
	return l.dc.SendText(string(b))
}

func (l *Link) SendBinary(b []byte) error {
	if l.isClosed() {
		return ErrClosed
	}
	return l.dc.Send(b)
}

func (l *Link) BufferedAmount() uint64 {
	if l.dc == nil {
		return 0
	}
	return l.dc.BufferedAmount()
}

// WaitDrain blocks until the send buffer is below the high-water mark.
func (l *Link) WaitDrain(ctx context.Context) error {
	for l.dc.BufferedAmount() > BufferHigh {
		select {
		case <-l.low:
		case <-time.After(100 * time.Millisecond): // belt and braces against a missed event
		case <-l.Done:
			return ErrClosed
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if l.isClosed() {
		return ErrClosed
	}
	return nil
}

func (l *Link) isClosed() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.closed
}

func (l *Link) fail(reason string) {
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return
	}
	l.closed = true
	l.Reason = reason
	if l.discTimer != nil {
		l.discTimer.Stop()
	}
	close(l.Done)
	l.mu.Unlock()
	go func() {
		if l.dc != nil {
			_ = l.dc.Close()
		}
		_ = l.pc.Close()
	}()
}

// Close tears the link down; Done fires with reason "closed".
func (l *Link) Close() { l.fail("closed") }

// Flush waits briefly for queued data-channel bytes to leave before Close.
func (l *Link) Flush(timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	for l.dc != nil && l.dc.BufferedAmount() > 0 && time.Now().Before(deadline) && !l.isClosed() {
		time.Sleep(20 * time.Millisecond)
	}
}
