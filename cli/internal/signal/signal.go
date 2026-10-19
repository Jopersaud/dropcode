// Package signal is the WebSocket client for the dropcode signaling server.
// Message shapes mirror server/src/protocol.ts.
package signal

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/pion/webrtc/v4"
)

type SignalData struct {
	Kind      string                   `json:"kind"`
	SDP       string                   `json:"sdp,omitempty"`
	Candidate *webrtc.ICECandidateInit `json:"candidate,omitempty"`
}

type ServerMessage struct {
	T               string             `json:"t"`
	IceServers      []webrtc.ICEServer `json:"iceServers"`
	IcePolicy       string             `json:"iceTransportPolicy"`
	Nameplate       string             `json:"nameplate"`
	Token           string             `json:"token"`
	ExpiresAt       int64              `json:"expiresAt"`
	ReceiverPresent bool               `json:"receiverPresent"`
	Data            *SignalData        `json:"data"`
	Reason          string             `json:"reason"`
	Code            string             `json:"code"`
}

// WSURL turns "https://host" / "host:8080" / "ws://host/ws" into the signaling URL.
func WSURL(server string) (string, error) {
	if !strings.Contains(server, "://") {
		server = "https://" + server
	}
	u, err := url.Parse(server)
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "https", "wss":
		u.Scheme = "wss"
	case "http", "ws":
		u.Scheme = "ws"
	default:
		return "", fmt.Errorf("unsupported server URL scheme %q", u.Scheme)
	}
	if u.Path == "" || u.Path == "/" {
		u.Path = "/ws"
	}
	return u.String(), nil
}

type Client struct {
	conn  *websocket.Conn
	Hello ServerMessage
	// Msgs delivers server messages in order; it is closed when the connection ends.
	Msgs   chan ServerMessage
	mu     sync.Mutex
	cancel context.CancelFunc
}

func Dial(ctx context.Context, wsURL string) (*Client, error) {
	dctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(dctx, wsURL, nil)
	if err != nil {
		return nil, err
	}
	conn.SetReadLimit(64 * 1024)
	var hello ServerMessage
	if err := readJSON(dctx, conn, &hello); err != nil || hello.T != "hello" {
		conn.CloseNow()
		return nil, fmt.Errorf("signaling handshake failed: %v", err)
	}
	lctx, lcancel := context.WithCancel(context.Background())
	c := &Client{conn: conn, Hello: hello, Msgs: make(chan ServerMessage, 64), cancel: lcancel}
	go c.readLoop(lctx)
	go c.pingLoop(lctx)
	return c, nil
}

func readJSON(ctx context.Context, conn *websocket.Conn, v any) error {
	_, data, err := conn.Read(ctx)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, v)
}

func (c *Client) readLoop(ctx context.Context) {
	defer close(c.Msgs)
	defer c.cancel()
	for {
		var m ServerMessage
		if err := readJSON(ctx, c.conn, &m); err != nil {
			if ctx.Err() == nil && websocket.CloseStatus(err) == -1 && strings.Contains(err.Error(), "json") {
				continue // ignore an undecodable frame
			}
			return
		}
		if m.T == "pong" {
			continue
		}
		select {
		case c.Msgs <- m:
		case <-ctx.Done():
			return
		}
	}
}

func (c *Client) pingLoop(ctx context.Context) {
	t := time.NewTicker(20 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			_ = c.Send(map[string]string{"t": "ping"})
		case <-ctx.Done():
			return
		}
	}
}

// Send writes one JSON message. Safe for concurrent use.
func (c *Client) Send(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return c.conn.Write(ctx, websocket.MessageText, b)
}

func (c *Client) Close() {
	c.cancel()
	_ = c.conn.Close(websocket.StatusNormalClosure, "")
}
