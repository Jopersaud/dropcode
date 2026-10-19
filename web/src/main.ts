import { Receiver, Sender, type Phase } from "./transfer.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const sendSection = $("send");
const fileInput = $<HTMLInputElement>("send-file");
const sendCode = $("send-code");
const sendStatus = $("send-status");
const recvSection = $("receive");
const recvForm = $<HTMLFormElement>("receive-form");
const recvCode = $<HTMLInputElement>("receive-code");
const recvStatus = $("receive-status");
const downloadLink = $<HTMLAnchorElement>("download-link");

const pct = (d: number, t: number) => (t ? Math.floor((d / t) * 100) : 100);

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  fileInput.disabled = true;
  const s = new Sender(file, {
    onPhase: (p: Phase) => {
      sendSection.dataset.phase = p;
      if (p !== "transferring") sendStatus.textContent = p;
    },
    onCode: (code) => {
      sendCode.textContent = code;
      sendCode.hidden = false;
    },
    onProgress: (d, t) => (sendStatus.textContent = `transferring ${pct(d, t)}%`),
    onError: (e) => {
      sendSection.dataset.error = e.code;
      sendStatus.textContent = `error: ${e.code}`;
    },
  });
  (window as any).__sender = s;
  s.start();
});

recvForm.addEventListener("submit", (ev) => {
  ev.preventDefault();
  recvCode.disabled = true;
  const r = new Receiver(recvCode.value, {
    onPhase: (p: Phase) => {
      recvSection.dataset.phase = p;
      if (p !== "transferring") recvStatus.textContent = p;
    },
    onProgress: (d, t) => (recvStatus.textContent = `receiving ${pct(d, t)}%`),
    onError: (e) => {
      recvSection.dataset.error = e.code;
      recvStatus.textContent = `error: ${e.code}`;
    },
    onComplete: ({ blob, name }) => {
      downloadLink.href = URL.createObjectURL(blob);
      downloadLink.download = name;
      downloadLink.hidden = false;
      downloadLink.click();
    },
  });
  (window as any).__receiver = r;
  r.start();
});

// Allow share links like https://host/#4-apple-river
if (location.hash.length > 1) recvCode.value = decodeURIComponent(location.hash.slice(1));
