// Package pake runs dropcode's SPAKE2 module: RustCrypto's spake2 crate
// compiled to WebAssembly (shared/pake.wasm), executed with the pure-Go
// wazero runtime. The browser client runs the identical binary.
package pake

import (
	"context"
	"crypto/rand"
	_ "embed"
	"errors"
	"fmt"
	"sync"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
)

//go:embed pake.wasm
var wasmBytes []byte

const (
	MsgLen = 33
	KeyLen = 32
)

// Side selects the asymmetric SPAKE2 role.
type Side uint32

const (
	SideA Side = 0 // sender
	SideB Side = 1 // receiver
)

var ErrFailed = errors.New("pake: handshake failed")

type module struct {
	mu                                sync.Mutex
	mem                               api.Memory
	alloc, free, start, finish, dropf api.Function
}

var (
	loadOnce sync.Once
	mod      *module
	loadErr  error
)

func load() (*module, error) {
	loadOnce.Do(func() {
		ctx := context.Background()
		rt := wazero.NewRuntime(ctx)
		m, err := rt.Instantiate(ctx, wasmBytes)
		if err != nil {
			loadErr = fmt.Errorf("pake: instantiate: %w", err)
			return
		}
		mod = &module{
			mem:    m.Memory(),
			alloc:  m.ExportedFunction("pake_alloc"),
			free:   m.ExportedFunction("pake_free"),
			start:  m.ExportedFunction("pake_start"),
			finish: m.ExportedFunction("pake_finish"),
			dropf:  m.ExportedFunction("pake_drop"),
		}
		if mod.alloc == nil || mod.free == nil || mod.start == nil || mod.finish == nil || mod.dropf == nil {
			loadErr = errors.New("pake: module is missing exports")
		}
	})
	return mod, loadErr
}

// call copies inputs into wasm memory, runs fn, copies outLen bytes back and
// wipes and frees every buffer. Callers hold m.mu.
func (m *module) call(inputs [][]byte, outLen int, fn func(ptrs []uint64, out uint64) (int32, error)) (int32, []byte, error) {
	ctx := context.Background()
	ptrs := make([]uint64, len(inputs))
	defer func() {
		for i, p := range ptrs {
			if p != 0 {
				_, _ = m.free.Call(ctx, p, uint64(len(inputs[i])))
			}
		}
	}()
	for i, b := range inputs {
		r, err := m.alloc.Call(ctx, uint64(len(b)))
		if err != nil {
			return 0, nil, err
		}
		ptrs[i] = r[0]
		if !m.mem.Write(uint32(r[0]), b) {
			return 0, nil, errors.New("pake: memory write out of range")
		}
	}
	r, err := m.alloc.Call(ctx, uint64(outLen))
	if err != nil {
		return 0, nil, err
	}
	outPtr := r[0]
	defer m.free.Call(ctx, outPtr, uint64(outLen))
	rc, err := fn(ptrs, outPtr)
	if err != nil {
		return 0, nil, err
	}
	view, ok := m.mem.Read(uint32(outPtr), uint32(outLen))
	if !ok {
		return 0, nil, errors.New("pake: memory read out of range")
	}
	return rc, append([]byte(nil), view...), nil
}

// State is one side of a SPAKE2 handshake in progress.
type State struct {
	m       *module
	handle  int32
	message []byte
	used    bool
}

// Start begins a handshake and returns our outbound message via Message().
func Start(side Side, password, idA, idB []byte) (*State, error) {
	m, err := load()
	if err != nil {
		return nil, err
	}
	seed := make([]byte, 32)
	if _, err := rand.Read(seed); err != nil {
		return nil, err
	}
	defer clear(seed)
	m.mu.Lock()
	defer m.mu.Unlock()
	ctx := context.Background()
	rc, msg, err := m.call([][]byte{password, idA, idB, seed}, MsgLen, func(p []uint64, out uint64) (int32, error) {
		r, err := m.start.Call(ctx, uint64(side), p[0], uint64(len(password)), p[1], uint64(len(idA)), p[2], uint64(len(idB)), p[3], out)
		if err != nil {
			return 0, err
		}
		return int32(uint32(r[0])), nil
	})
	if err != nil {
		return nil, err
	}
	if rc < 0 {
		return nil, ErrFailed
	}
	return &State{m: m, handle: rc, message: msg}, nil
}

// Message is our 33-byte SPAKE2 message for the peer.
func (s *State) Message() []byte { return s.message }

// Finish combines the peer's message into the 32-byte shared key. The state is
// single-use; reflected or malformed messages return ErrFailed.
func (s *State) Finish(peer []byte) ([]byte, error) {
	s.m.mu.Lock()
	defer s.m.mu.Unlock()
	ctx := context.Background()
	if s.used {
		return nil, errors.New("pake: state already used")
	}
	s.used = true
	if len(peer) != MsgLen {
		_, _ = s.m.dropf.Call(ctx, uint64(uint32(s.handle)))
		return nil, ErrFailed
	}
	rc, key, err := s.m.call([][]byte{peer}, KeyLen, func(p []uint64, out uint64) (int32, error) {
		r, err := s.m.finish.Call(ctx, uint64(uint32(s.handle)), p[0], uint64(len(peer)), out)
		if err != nil {
			return 0, err
		}
		return int32(uint32(r[0])), nil
	})
	if err != nil {
		return nil, err
	}
	if rc != 0 {
		return nil, ErrFailed
	}
	return key, nil
}
