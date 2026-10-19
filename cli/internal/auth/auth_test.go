package auth

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jopersaud/dropcode/cli/internal/proto"
)

func TestVectors(t *testing.T) {
	raw, err := os.ReadFile("../../../shared/auth-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Vectors []struct {
			Key, FpSender, FpReceiver, Transcript, MacSender, MacReceiver string
		}
	}
	// Field names in the file use snake case for the MACs.
	raw = []byte(strings.NewReplacer(`"mac_sender"`, `"macSender"`, `"mac_receiver"`, `"macReceiver"`).Replace(string(raw)))
	if err := json.Unmarshal(raw, &f); err != nil || len(f.Vectors) == 0 {
		t.Fatal("bad vectors", err)
	}
	for _, v := range f.Vectors {
		K, _ := hex.DecodeString(v.Key)
		T := Transcript(v.FpSender, v.FpReceiver)
		if string(T) != v.Transcript {
			t.Fatal("transcript mismatch")
		}
		ms, _ := ConfirmationMAC(K, T, Sender)
		mr, _ := ConfirmationMAC(K, T, Receiver)
		if hex.EncodeToString(ms) != v.MacSender || hex.EncodeToString(mr) != v.MacReceiver {
			t.Fatal("MAC mismatch with reference vectors")
		}
	}
}

type pipeCh struct {
	in  chan []byte
	out chan []byte
	tap func([]byte) []byte
}

func (p *pipeCh) Send(b []byte) error {
	if p.tap != nil {
		b = p.tap(b)
	}
	p.out <- b
	return nil
}

func (p *pipeCh) Recv(ctx context.Context, typ string) (*proto.Message, error) {
	select {
	case b := <-p.in:
		m, err := proto.Parse(b)
		if err != nil || m.T != typ {
			return nil, errors.New("unexpected message")
		}
		return m, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func sdp(fp string) string {
	return "v=0\r\na=fingerprint:sha-256 " + fp + "\r\n"
}

func run(t *testing.T, codeS, codeR string, sView, rView [2]string) (error, error) {
	a2b, b2a := make(chan []byte, 8), make(chan []byte, 8)
	cs := &pipeCh{in: b2a, out: a2b}
	cr := &pipeCh{in: a2b, out: b2a}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	errs := make(chan error, 1)
	go func() { errs <- Authenticate(ctx, Sender, codeS, sView[0], sView[1], cs) }()
	er := Authenticate(ctx, Receiver, codeR, rView[0], rView[1], cr)
	return <-errs, er
}

var (
	fpS = strings.Repeat("AA:", 31) + "AA"
	fpR = strings.Repeat("BB:", 31) + "BB"
	fpM = strings.Repeat("CC:", 31) + "CC"
)

func TestAuthenticate(t *testing.T) {
	honestS, honestR := [2]string{sdp(fpS), sdp(fpR)}, [2]string{sdp(fpR), sdp(fpS)}
	if es, er := run(t, "4-apple-river", "4-apple-river", honestS, honestR); es != nil || er != nil {
		t.Fatal("honest handshake failed:", es, er)
	}
	if es, er := run(t, "4-apple-river", "4-apple-rival", honestS, honestR); !errors.Is(es, ErrAuth) || !errors.Is(er, ErrAuth) {
		t.Fatal("wrong code was not rejected:", es, er)
	}
	mitmS, mitmR := [2]string{sdp(fpS), sdp(fpM)}, [2]string{sdp(fpR), sdp(fpM)}
	if es, er := run(t, "4-apple-river", "4-apple-river", mitmS, mitmR); !errors.Is(es, ErrAuth) || !errors.Is(er, ErrAuth) {
		t.Fatal("fingerprint swap was not detected:", es, er)
	}
}
