// A malicious signaling server for testing. It serves the real web client but
// routes each victim's WebRTC negotiation to a man-in-the-middle browser page,
// which terminates DTLS separately with the sender and the receiver and relays
// every data-channel message between them verbatim.
//
// mode "mitm":   sender <-> MITM page <-> receiver
// mode "honest": plain relay (control experiment: proves this server works)
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { root } from "./lib.mjs";

export async function startEvilServer(mode) {
  const files = { "/": "index.html", "/app.js": "app.js", "/style.css": "style.css" };
  const http = createServer(async (req, res) => {
    const f = files[req.url.split("?")[0]];
    if (!f) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": f.endsWith(".js") ? "text/javascript" : f.endsWith(".css") ? "text/css" : "text/html" });
    res.end(await readFile(join(root, "web/dist", f)));
  });
  const wss = new WebSocketServer({ server: http });
  const state = { sender: null, receiver: null, mitm: null, senderReports: [] };
  const send = (ws, m) => ws?.readyState === 1 && ws.send(JSON.stringify(m));

  wss.on("connection", (ws, req) => {
    if (req.url === "/mitm") {
      state.mitm = ws;
      ws.on("message", (raw) => {
        const m = JSON.parse(raw);
        // The MITM's "A" side faces the sender, its "B" side faces the receiver.
        if (m.from === "A") send(state.sender, { t: "signal", data: m.data });
        if (m.from === "B") send(state.receiver, { t: "signal", data: m.data });
      });
      return;
    }
    send(ws, { t: "hello", iceServers: [], ttlMs: 600000 });
    ws.on("message", (raw) => {
      const m = JSON.parse(raw);
      if (m.t === "create") {
        state.sender = ws;
        send(ws, { t: "created", nameplate: "7", token: "x".repeat(24), expiresAt: Date.now() + 600000 });
      } else if (m.t === "join") {
        state.receiver = ws;
        send(ws, { t: "joined" });
        send(state.sender, { t: "peer_joined" });
        if (mode === "mitm") send(state.mitm, { event: "receiver_joined" });
      } else if (m.t === "signal") {
        const fromSender = ws === state.sender;
        if (mode === "mitm") send(state.mitm, { to: fromSender ? "A" : "B", data: m.data });
        else send(fromSender ? state.receiver : state.sender, m);
      } else if (ws === state.sender && m.t !== "ping") {
        state.senderReports.push(m.t);
      }
    });
  });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${http.address().port}`,
    state,
    stop: () => {
      wss.close();
      http.close();
      http.closeAllConnections();
    },
  };
}

/** Runs inside the MITM browser page. Records every relayed control message type. */
export function mitmPageScript() {
  const ws = new WebSocket(`ws://${location.host}/mitm`);
  const seen = (window.__seen = []);
  const pcA = new RTCPeerConnection(); // talks to the sender (we play receiver)
  const pcB = new RTCPeerConnection(); // talks to the receiver (we play sender)
  const tx = (from, data) => ws.send(JSON.stringify({ from, data }));
  pcA.onicecandidate = (e) => e.candidate && tx("A", { kind: "candidate", candidate: e.candidate.toJSON() });
  pcB.onicecandidate = (e) => e.candidate && tx("B", { kind: "candidate", candidate: e.candidate.toJSON() });

  let dcA = null;
  const dcB = pcB.createDataChannel("dropcode", { ordered: true });
  const qA = [], qB = [];
  const relay = (src, dst, q, label) => {
    src.binaryType = "arraybuffer";
    src.onmessage = (e) => {
      seen.push(typeof e.data === "string" ? `${label}:${JSON.parse(e.data).t}` : `${label}:binary`);
      if (dst.readyState === "open") dst.send(e.data);
      else q.push(e.data);
    };
  };
  const flush = (dc, q) => (dc.onopen = () => q.splice(0).forEach((d) => dc.send(d)));
  pcA.ondatachannel = (e) => {
    dcA = e.channel;
    relay(dcA, dcB, qB, "S->R");
    relay(dcB, dcA, qA, "R->S");
    if (dcA.readyState === "open") qA.splice(0).forEach((d) => dcA.send(d));
    else flush(dcA, qA);
  };
  flush(dcB, qB);

  ws.onmessage = async (ev) => {
    const m = JSON.parse(ev.data);
    if (m.event === "receiver_joined") {
      await pcB.setLocalDescription(await pcB.createOffer());
      tx("B", { kind: "offer", sdp: pcB.localDescription.sdp });
      return;
    }
    const pc = m.to === "A" ? pcA : pcB;
    const d = m.data;
    if (d.kind === "offer") {
      await pc.setRemoteDescription({ type: "offer", sdp: d.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      tx(m.to, { kind: "answer", sdp: pc.localDescription.sdp });
    } else if (d.kind === "answer") await pc.setRemoteDescription({ type: "answer", sdp: d.sdp });
    else if (d.kind === "candidate") await pc.addIceCandidate(d.candidate).catch(() => {});
  };
  return new Promise((r) => (ws.onopen = r));
}
