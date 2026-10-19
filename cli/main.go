// Command dropcode sends and receives files peer to peer, interoperating
// with the dropcode web client.
//
//	dropcode send <file>       prints a code and waits for the receiver
//	dropcode receive <code>    downloads into the current directory
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/jopersaud/dropcode/cli/internal/proto"
	sig "github.com/jopersaud/dropcode/cli/internal/signal"
	"github.com/jopersaud/dropcode/cli/internal/transfer"
)

var version = "dev"

func usage() {
	fmt.Fprintf(os.Stderr, `dropcode %s: send files peer to peer with a short code

Usage:
  dropcode send [flags] <file>
  dropcode receive [flags] <code>

Flags:
  -server URL   signaling server (default $DROPCODE_SERVER or http://localhost:8080)
  -o DIR        receive: directory to save into (default: current directory)
  -q            no progress output

A receive that is interrupted (Ctrl-C, lost network) can be resumed by running
the same command again while the sender is still waiting.
`, version)
}

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	cmd := os.Args[1]
	fs := flag.NewFlagSet(cmd, flag.ExitOnError)
	fs.Usage = usage
	server := fs.String("server", envOr("DROPCODE_SERVER", "http://localhost:8080"), "signaling server URL")
	out := fs.String("o", ".", "output directory (receive)")
	quiet := fs.Bool("q", false, "no progress output")
	_ = fs.Parse(os.Args[2:])
	if fs.NArg() != 1 || (cmd != "send" && cmd != "receive" && cmd != "recv") {
		usage()
		os.Exit(2)
	}
	wsURL, err := sig.WSURL(*server)
	if err != nil {
		fatal(err)
	}
	ui := &termUI{quiet: *quiet, w: os.Stderr, role: cmd}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	switch cmd {
	case "send":
		s, err := transfer.NewSender(wsURL, fs.Arg(0), ui)
		if err != nil {
			fatal(err)
		}
		defer s.Close()
		go func() {
			<-ctx.Done()
			s.Cancel()
		}()
		err = s.Run(context.Background())
		ui.finish()
		if err != nil {
			fatal(err)
		}
		fmt.Fprintln(os.Stderr, "Sent. The receiver has the file and its checksum matched.")
	default:
		info, err := os.Stat(*out)
		if err != nil || !info.IsDir() {
			fatal(fmt.Errorf("output directory %q does not exist", *out))
		}
		r, err := transfer.NewReceiver(wsURL, fs.Arg(0), *out, ui)
		if err != nil {
			fatal(err)
		}
		err = r.Run(ctx)
		ui.finish()
		if errors.Is(err, context.Canceled) {
			fmt.Fprintln(os.Stderr, "Interrupted. Run the same command again to resume.")
			os.Exit(130)
		}
		if err != nil {
			fatal(err)
		}
		fmt.Fprintf(os.Stderr, "Received %s (checksum verified).\n", r.Path)
		fmt.Println(r.Path)
	}
}

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func fatal(err error) {
	var te *transfer.Error
	if errors.As(err, &te) && te.Code == "cancelled" {
		fmt.Fprintln(os.Stderr, "Cancelled.")
		os.Exit(130)
	}
	fmt.Fprintln(os.Stderr, "dropcode:", err)
	os.Exit(1)
}

// termUI renders status and a single updating progress line on stderr.
type termUI struct {
	w       io.Writer
	quiet   bool
	role    string
	total   int64
	samples []sample
	inLine  bool
}

type sample struct {
	t time.Time
	b int64
}

func (u *termUI) line(s string) {
	if u.inLine {
		fmt.Fprint(u.w, "\r\033[K")
		u.inLine = false
	}
	fmt.Fprintln(u.w, s)
}

func (u *termUI) Phase(p string) {
	msg := map[string]string{
		"connecting-peer": "Connecting to peer…",
		"authenticating":  "Verifying the code with the other side…",
		"verifying":       "Verifying checksum…",
		"reconnecting":    "Connection lost; waiting to reconnect and resume…",
	}[p]
	if p == "transferring" {
		u.samples = nil
	}
	if msg != "" && !u.quiet {
		u.line(msg)
	}
}

func (u *termUI) Code(code string, expires time.Time) {
	fmt.Fprintf(u.w, "\nCode: %s\n\nOn the other device, open the dropcode page and enter the code, or run:\n  dropcode receive %s\n\nThe code expires at %s if unused. Waiting for the receiver…\n",
		code, code, expires.Format("15:04"))
	fmt.Println(code) // stdout gets just the code, for scripts
}

func (u *termUI) Meta(m proto.FileMeta) {
	u.total = m.Size
	if !u.quiet {
		u.line(fmt.Sprintf("Receiving %s (%s)", m.Name, bytes(m.Size)))
	}
}

func (u *termUI) Notice(msg string) { u.line("Note: " + msg) }

func (u *termUI) Progress(done, total int64) {
	if u.quiet {
		return
	}
	now := time.Now()
	u.samples = append(u.samples, sample{now, done})
	for len(u.samples) > 2 && now.Sub(u.samples[0].t) > 3*time.Second {
		u.samples = u.samples[1:]
	}
	pct := 100.0
	if total > 0 {
		pct = float64(done) * 100 / float64(total)
	}
	parts := []string{fmt.Sprintf("%5.1f%%", pct), fmt.Sprintf("%s of %s", bytes(done), bytes(total))}
	if first := u.samples[0]; done < total && now.Sub(first.t) > 250*time.Millisecond {
		rate := float64(done-first.b) / now.Sub(first.t).Seconds()
		if rate > 0 {
			eta := time.Duration(float64(total-done)/rate) * time.Second
			parts = append(parts, bytes(int64(rate))+"/s", eta.Round(time.Second).String()+" left")
		}
	}
	fmt.Fprintf(u.w, "\r\033[K%s", strings.Join(parts, " · "))
	u.inLine = true
}

func (u *termUI) finish() {
	if u.inLine {
		fmt.Fprintln(u.w)
		u.inLine = false
	}
}

func bytes(n int64) string {
	units := []string{"B", "KB", "MB", "GB", "TB"}
	f, i := float64(n), 0
	for f >= 1000 && i < len(units)-1 {
		f /= 1000
		i++
	}
	if i == 0 {
		return fmt.Sprintf("%d B", n)
	}
	if f < 10 {
		return fmt.Sprintf("%.1f %s", f, units[i])
	}
	return fmt.Sprintf("%.0f %s", f, units[i])
}
