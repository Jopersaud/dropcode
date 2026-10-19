// Package auth mirrors web/src/auth.ts: SPAKE2 keyed by the code, then key
// confirmation over both peers' DTLS fingerprints. See that file and
// DECISIONS.md for the rationale.
package auth

import (
	"context"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/jopersaud/dropcode/cli/internal/pake"
	"github.com/jopersaud/dropcode/cli/internal/proto"
)

type Role string

const (
	Sender   Role = "sender"
	Receiver Role = "receiver"
)

var (
	IDSender   = []byte("dropcode-sender")
	IDReceiver = []byte("dropcode-receiver")
	ErrAuth    = errors.New("authentication failed")
	fpRE       = regexp.MustCompile(`^a=fingerprint:(\S+)\s+([0-9A-Fa-f:]+)\s*$`)
)

// Fingerprints returns the canonical DTLS fingerprint set announced by an SDP.
func Fingerprints(sdp string) (string, error) {
	set := map[string]bool{}
	for _, line := range strings.Split(sdp, "\n") {
		if m := fpRE.FindStringSubmatch(strings.TrimRight(line, "\r")); m != nil {
			set[strings.ToLower(m[1])+" "+strings.ToUpper(m[2])] = true
		}
	}
	if len(set) == 0 {
		return "", errors.New("SDP has no DTLS fingerprint")
	}
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return strings.Join(out, ","), nil
}

func Transcript(fpSender, fpReceiver string) []byte {
	return []byte("dropcode-v1 confirm\n" + fpSender + "\n" + fpReceiver)
}

// ConfirmationMAC = HMAC-SHA256(HKDF-SHA256(K, salt="", info="dropcode-v1 confirm <role>"), T).
func ConfirmationMAC(K, T []byte, role Role) ([]byte, error) {
	k, err := hkdf.Key(sha256.New, K, nil, "dropcode-v1 confirm "+string(role), 32)
	if err != nil {
		return nil, err
	}
	h := hmac.New(sha256.New, k)
	h.Write(T)
	return h.Sum(nil), nil
}

// Channel carries the handshake messages over the data channel.
type Channel interface {
	Send([]byte) error
	// Recv returns the next control message, which must be of type t.
	Recv(ctx context.Context, t string) (*proto.Message, error)
}

// Authenticate runs the handshake; any failure (including a wrong code or a
// fingerprint mismatch) returns an error wrapping ErrAuth or a transport error.
func Authenticate(ctx context.Context, role Role, code, localSDP, remoteSDP string, ch Channel) error {
	local, err := Fingerprints(localSDP)
	if err != nil {
		return err
	}
	remote, err := Fingerprints(remoteSDP)
	if err != nil {
		return err
	}
	T := Transcript(local, remote)
	side, peerRole := pake.SideA, Receiver
	if role == Receiver {
		T = Transcript(remote, local)
		side, peerRole = pake.SideB, Sender
	}

	st, err := pake.Start(side, []byte(code), IDSender, IDReceiver)
	if err != nil {
		return err
	}
	if err := ch.Send(proto.Pake(base64.StdEncoding.EncodeToString(st.Message()))); err != nil {
		return err
	}
	pm, err := ch.Recv(ctx, "pake")
	if err != nil {
		return err
	}
	peerMsg, err := base64.StdEncoding.DecodeString(pm.Msg)
	if err != nil {
		return fmt.Errorf("%w: bad PAKE encoding", ErrAuth)
	}
	K, err := st.Finish(peerMsg)
	if err != nil {
		return fmt.Errorf("%w: PAKE failed", ErrAuth)
	}
	defer clear(K)

	mine, err := ConfirmationMAC(K, T, role)
	if err != nil {
		return err
	}
	expected, err := ConfirmationMAC(K, T, peerRole)
	if err != nil {
		return err
	}
	if err := ch.Send(proto.Confirm(base64.StdEncoding.EncodeToString(mine))); err != nil {
		return err
	}
	cm, err := ch.Recv(ctx, "confirm")
	if err != nil {
		return err
	}
	got, err := base64.StdEncoding.DecodeString(cm.Mac)
	if err != nil || !hmac.Equal(got, expected) {
		return fmt.Errorf("%w: key confirmation failed", ErrAuth)
	}
	return nil
}
