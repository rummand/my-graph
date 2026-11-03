import { describe, expect, it } from "vitest";
import { decodeHeader, emailToText, htmlToText, parseEmail } from "./email";

describe("parseEmail", () => {
  it("reads headers and the plain-text part of a multipart message", () => {
    const raw = [
      "From: =?utf-8?Q?S=C3=B8ren?= <soren@skole.dk>",
      "To: mor@example.dk",
      "Subject: =?UTF-8?B?Rm9yw6ZsZHJlbcO4ZGU=?=",
      "Date: Tue, 3 Nov 2026 08:15:00 +0100",
      'Content-Type: multipart/alternative; boundary="b1"',
      "",
      "--b1",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Hej for=C3=A6ldre, husk madpakke p=C3=A5 fredag.=",
      "",
      "--b1",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>Hej</p>",
      "--b1--",
    ].join("\r\n");
    const e = parseEmail(raw);
    expect(e.from).toBe("Søren <soren@skole.dk>");
    expect(e.subject).toBe("Forældremøde");
    expect(e.date?.toISOString()).toBe("2026-11-03T07:15:00.000Z");
    expect(e.body).toBe("Hej forældre, husk madpakke på fredag.");
    expect(emailToText(e)).toContain("Subject: ");
  });

  it("falls back to HTML and lists attachments", () => {
    const raw = [
      "Subject: Plan",
      'Content-Type: multipart/mixed; boundary="x"',
      "",
      "--x",
      "Content-Type: text/html",
      "",
      "<div>Line one<br>Line &amp; two</div><style>p{}</style>",
      "--x",
      'Content-Type: application/pdf; name="plan.pdf"',
      "Content-Disposition: attachment; filename=\"plan.pdf\"",
      "Content-Transfer-Encoding: base64",
      "",
      "JVBERi0=",
      "--x--",
    ].join("\n");
    const e = parseEmail(raw);
    expect(e.body).toBe("Line one\nLine & two");
    expect(e.attachments).toEqual(["plan.pdf"]);
  });

  it("handles a simple non-multipart message", () => {
    const e = parseEmail("Subject: Hi\n\nJust text");
    expect(e).toMatchObject({ subject: "Hi", body: "Just text", attachments: [] });
  });

  it("decodes headers and strips html", () => {
    expect(decodeHeader("=?iso-8859-1?Q?K=F8benhavn?=")).toBe("København");
    expect(htmlToText("<script>x</script><p>a</p><p>b</p>")).toBe("a\nb");
  });
});
