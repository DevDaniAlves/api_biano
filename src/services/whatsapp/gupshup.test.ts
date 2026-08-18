import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildAccessInteractiveMessage,
  buildSessionMessage,
  buildTemplateJson,
  extractGupshupMessageId,
  gupshupSubmitOk,
  isRetryableStatus,
  mapGupshupDeliveryStatus,
  parseGupshupEnvelope,
  templateParamsFromComponents,
  unwrapGupshupBodies,
} from "./gupshup-mapper.js";
import { isInternalMediaUrl, isUnreachableMediaUrl } from "./gupshup.js";
import { isWebmAudio, normalizeGupshupAudioMime } from "./gupshup-audio.js";

describe("gupshup mapper outbound", () => {
  it("monta texto, imagem, arquivo e template oficiais", () => {
    assert.equal(
      buildSessionMessage({ kind: "text", text: "oi" }),
      JSON.stringify({ type: "text", text: "oi" })
    );
    const img = JSON.parse(
      buildSessionMessage({ kind: "image", url: "https://x/a.jpg", caption: "foto" })
    );
    assert.equal(img.type, "image");
    assert.equal(img.originalUrl, "https://x/a.jpg");
    assert.equal(img.previewUrl, "https://x/a.jpg");
    assert.equal(img.url, "https://x/a.jpg");
    assert.equal(img.caption, "foto");
    const byId = JSON.parse(
      buildSessionMessage({ kind: "image", mediaId: "3674626312780147", caption: "oi" })
    );
    assert.equal(byId.id, "3674626312780147");
    assert.equal(byId.caption, "oi");
    const file = JSON.parse(
      buildSessionMessage({ kind: "file", url: "https://x/a.pdf", filename: "boleto.pdf" })
    );
    assert.equal(file.type, "file");
    assert.equal(file.filename, "boleto.pdf");
    assert.equal(
      buildTemplateJson({ id: "uuid-1", params: ["Maria", "10,00"] }),
      JSON.stringify({ id: "uuid-1", params: ["Maria", "10,00"] })
    );
  });

  it("extrai params do componente Meta body", () => {
    const params = templateParamsFromComponents([
      {
        type: "body",
        parameters: [{ type: "text", text: "Ana" }, { type: "text", text: "9,90" }],
      },
    ]);
    assert.deepEqual(params, ["Ana", "9,90"]);
  });

  it("não trata 200 submitted como retry", () => {
    assert.equal(isRetryableStatus(200), false);
    assert.equal(isRetryableStatus(429), true);
    assert.equal(isRetryableStatus(503), true);
    assert.equal(gupshupSubmitOk({ status: "submitted", messageId: "abc1234" }, true), true);
    assert.equal(gupshupSubmitOk({ status: "error", message: "fail" }, true), false);
    assert.equal(extractGupshupMessageId({ status: "submitted", messageId: "msg-99xx" }), "msg-99xx");
  });

  it("detecta URL inacessível para Gupshup", () => {
    assert.equal(isUnreachableMediaUrl("http://localhost:3333/uploads/foto.jpg"), true);
    assert.equal(isUnreachableMediaUrl("https://apibiano-production.up.railway.app/uploads/foto.jpg"), false);
    assert.equal(isUnreachableMediaUrl("https://gs-upload.gupshup.io/whatsapp/sample-media/png/sample01.png"), false);
    assert.equal(isInternalMediaUrl("http://127.0.0.1/uploads/x.jpg"), true);
  });

  it("normaliza MIME de áudio para Gupshup", () => {
    assert.equal(normalizeGupshupAudioMime("audio/ogg"), "audio/ogg; codecs=opus");
    assert.equal(normalizeGupshupAudioMime("audio/webm;codecs=opus"), "audio/webm");
    assert.equal(normalizeGupshupAudioMime("audio/mp4", "gravacao.m4a"), "audio/mp4");
    assert.equal(isWebmAudio("audio/webm"), true);
    assert.equal(isWebmAudio("audio/ogg; codecs=opus", "x.ogg"), false);
  });

  it("converte botão Meta em quick_reply da Access API", () => {
    const msg = JSON.parse(
      buildAccessInteractiveMessage({
        type: "button",
        body: { text: "Escolha o setor:" },
        action: {
          buttons: [
            { type: "reply", reply: { id: "1", title: "Atendimento" } },
            { type: "reply", reply: { id: "2", title: "Financeiro" } },
          ],
        },
      })
    );
    assert.equal(msg.type, "quick_reply");
    assert.equal(msg.content.text, "Escolha o setor:");
    assert.equal(msg.options[0].postbackText, "1");
    assert.equal(msg.options[1].title, "Financeiro");
  });

  it("converte lista Meta em list da Access API", () => {
    const msg = JSON.parse(
      buildAccessInteractiveMessage({
        type: "list",
        body: { text: "Escolha o atendente:" },
        action: {
          button: "Ver opções",
          sections: [
            {
              title: "Atendimento",
              rows: [
                { id: "1", title: "Ana" },
                { id: "0", title: "Voltar" },
              ],
            },
          ],
        },
      })
    );
    assert.equal(msg.type, "list");
    assert.equal(msg.globalButtons[0].title, "Ver opções");
    assert.equal(msg.items[0].options[1].postbackText, "0");
  });
});

describe("gupshup webhook mapper", () => {
  it("inbound texto + quote", () => {
    const parsed = parseGupshupEnvelope({
      app: "Calangus",
      type: "message",
      payload: {
        id: "wamid.ABC",
        source: "5566999999999",
        type: "text",
        payload: { text: "oi" },
        sender: { phone: "5566999999999", name: "João" },
        context: { id: "wamid.QUOTED", gsId: "gs-1" },
      },
    });
    assert.equal(parsed.kind, "message");
    assert.equal(parsed.phone, "5566999999999");
    assert.equal(parsed.body, "oi");
    assert.equal(parsed.externalId, "wamid.ABC");
    assert.equal(parsed.quotedExternalId, "wamid.QUOTED");
    assert.equal(parsed.profileName, "João");
  });

  it("inbound imagem baixa URL no payload", () => {
    const parsed = parseGupshupEnvelope({
      type: "message",
      payload: {
        id: "wamid.IMG",
        source: "5566988888888",
        type: "image",
        payload: { url: "https://media.gupshup.io/a.jpg", caption: "look" },
        sender: { phone: "5566988888888" },
      },
    });
    assert.equal(parsed.crmType, "image");
    assert.equal(parsed.mediaUrl, "https://media.gupshup.io/a.jpg");
    assert.equal(parsed.body, "look");
  });

  it("message-event delivered mapeia status", () => {
    const parsed = parseGupshupEnvelope({
      type: "message-event",
      payload: {
        id: "wamid.OUT",
        gsId: "gs-out-1",
        type: "delivered",
        destination: "5566111111111",
      },
    });
    assert.equal(parsed.kind, "message-event");
    assert.equal(parsed.status, "delivered");
    assert.equal(parsed.gsId, "gs-out-1");
    assert.equal(parsed.externalId, "wamid.OUT");
    assert.equal(mapGupshupDeliveryStatus("enqueued"), "queued");
    assert.equal(mapGupshupDeliveryStatus("failed"), "failed");
  });

  it("duplicata: mesmo envelope gera o mesmo externalId", () => {
    const raw = {
      type: "message",
      payload: {
        id: "wamid.DUP",
        source: "5566222222222",
        type: "text",
        payload: { text: "ping" },
        sender: { phone: "5566222222222" },
      },
    };
    const a = parseGupshupEnvelope(raw);
    const b = parseGupshupEnvelope(raw);
    assert.equal(a.externalId, b.externalId);
    assert.equal(a.externalId, "wamid.DUP");
  });

  it("provider desconectado / payload vazio não lança", () => {
    assert.doesNotThrow(() => parseGupshupEnvelope({}));
    assert.doesNotThrow(() => unwrapGupshupBodies(null));
    assert.deepEqual(unwrapGupshupBodies(null), []);
    const parsed = parseGupshupEnvelope({ type: "user-event", payload: { type: "history" } });
    assert.equal(parsed.kind, "user-event");
    const other = parseGupshupEnvelope({ type: "account-event", payload: {} });
    assert.equal(other.kind, "other");
  });

  it("botão / lista inbound usa o id (1, 2, 0)", () => {
    const btn = parseGupshupEnvelope({
      type: "message",
      payload: {
        id: "wamid.BTN",
        source: "5566992838885",
        type: "button_reply",
        payload: { id: "1", title: "Atendimento" },
        sender: { phone: "5566992838885" },
      },
    });
    assert.equal(btn.body, "1");
    const list = parseGupshupEnvelope({
      type: "message",
      payload: {
        id: "wamid.LIST",
        source: "5566992838885",
        type: "list_reply",
        payload: { id: "0", title: "Voltar" },
        sender: { phone: "5566992838885" },
      },
    });
    assert.equal(list.body, "0");
    const byTitle = parseGupshupEnvelope({
      type: "message",
      payload: {
        id: "wamid.FIN",
        source: "5566992838885",
        type: "button_reply",
        payload: { title: "Financeiro" },
        sender: { phone: "5566992838885" },
      },
    });
    assert.equal(byTitle.body, "2");
    const listType = parseGupshupEnvelope({
      type: "message",
      payload: {
        id: "wamid.LIST2",
        source: "5566992838885",
        type: "list",
        payload: { id: "list", title: "neiliane", postbackText: "1" },
        sender: { phone: "5566992838885" },
      },
    });
    assert.equal(listType.body, "1");
  });
});
