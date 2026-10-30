import { describe, expect, it } from "vitest";
import { canSeeFolder, decodeEntities, htmlToBlocks, mergeTemplate, parseAccess, placeholdersIn, safeFileName, sanitizeHtml, unknownPlaceholders, validateUpload, MAX_UPLOAD_BYTES, DEFAULT_LETTERS } from "./rules";

const bytes = (...b: number[]) => new Uint8Array(b);
const PDF = bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31);

describe("folder access", () => {
  const p = { department_id: "eng", location_id: "blr" };
  it("everyone folders are visible to all", () => expect(canSeeFolder({ type: "org" }, { department_id: null, location_id: null })).toBe(true));
  it("department folders only for those departments", () => {
    expect(canSeeFolder({ type: "departments", ids: ["eng"] }, p)).toBe(true);
    expect(canSeeFolder({ type: "departments", ids: ["sales"] }, p)).toBe(false);
    expect(canSeeFolder({ type: "departments", ids: ["eng"] }, { department_id: null, location_id: "blr" })).toBe(false);
  });
  it("location folders only for those locations", () => {
    expect(canSeeFolder({ type: "locations", ids: ["blr"] }, p)).toBe(true);
    expect(canSeeFolder({ type: "locations", ids: ["pune"] }, p)).toBe(false);
  });
  it("bad or empty access settings fall back to everyone", () => {
    expect(parseAccess(null)).toEqual({ type: "org" });
    expect(parseAccess({ type: "departments", ids: [] })).toEqual({ type: "org" });
    expect(parseAccess({ type: "locations", ids: ["a", 3] })).toEqual({ type: "locations", ids: ["a"] });
  });
});

describe("uploads", () => {
  it("accepts a real PDF and derives the MIME type from the extension", () => {
    expect(validateUpload({ name: "Leave policy.PDF", size: 2000, head: PDF })).toEqual({ ok: true, mime: "application/pdf", name: "Leave policy.PDF" });
  });
  it("refuses disallowed types, empty and oversized files", () => {
    expect(validateUpload({ name: "run.exe", size: 10, head: bytes(0x4d, 0x5a) }).ok).toBe(false);
    expect(validateUpload({ name: "page.html", size: 10, head: bytes(0x3c) }).ok).toBe(false);
    expect(validateUpload({ name: "a.pdf", size: 0, head: PDF }).ok).toBe(false);
    expect(validateUpload({ name: "a.pdf", size: MAX_UPLOAD_BYTES + 1, head: PDF }).ok).toBe(false);
  });
  it("refuses a file whose contents don't match its extension", () => {
    const r = validateUpload({ name: "invoice.pdf", size: 100, head: bytes(0x4d, 0x5a, 0x90, 0x00) });
    expect(r.ok).toBe(false);
    expect(validateUpload({ name: "sheet.xlsx", size: 100, head: bytes(0x50, 0x4b, 0x03, 0x04) }).ok).toBe(true);
    expect(validateUpload({ name: "notes.txt", size: 3, head: bytes(0x61, 0x00, 0x62) }).ok).toBe(false);
  });
  it("cleans file names", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName('C:\\Users\\me\\"bad"<name>.pdf')).toBe("badname.pdf");
    expect(safeFileName("")).toBe("file");
    const long = safeFileName("x".repeat(300) + ".pdf");
    expect(long.length).toBe(120); expect(long.endsWith(".pdf")).toBe(true);
  });
});

describe("letter HTML", () => {
  it("keeps the allowed tags and strips every attribute", () => {
    expect(sanitizeHtml('<p style="color:red" onclick="x()">Hi <b>there</b> <i>you</i></p>')).toBe("<p>Hi <strong>there</strong> <em>you</em></p>");
  });
  it("drops scripts, styles and comments with their content, and unknown tags but not their text", () => {
    expect(sanitizeHtml("<p>a<script>alert(1)</script>b<style>p{}</style><!-- c --></p>")).toBe("<p>ab</p>");
    expect(sanitizeHtml('<a href="javascript:x">link</a><img src=x onerror=alert(1)>')).toBe("link");
    expect(sanitizeHtml("<script><script>x</script></script>ok")).toBe("ok");
    expect(sanitizeHtml("1 < 2 and 3 > 2")).toBe("1 &lt; 2 and 3 &gt; 2");
  });
  it("finds placeholders and flags unknown ones", () => {
    const html = "<p>{{employee.name}} {{ company.name }} {{employee.salary}} {{employee.name}}</p>";
    expect(placeholdersIn(html)).toEqual(["employee.name", "company.name", "employee.salary"]);
    expect(unknownPlaceholders(html)).toEqual(["employee.salary"]);
    for (const l of DEFAULT_LETTERS) expect(unknownPlaceholders(l.body)).toEqual([]);
  });
  it("merges values escaped, and reports what's missing", () => {
    const r = mergeTemplate("<p>Dear {{employee.name}}, from {{company.name}} on {{employee.last_working_date}}</p>", { "employee.name": "A <b>B</b>", "company.name": "Acme & Co" });
    expect(r.html).toBe("<p>Dear A &lt;b&gt;B&lt;/b&gt;, from Acme &amp; Co on [Last working day]</p>");
    expect(r.missing).toEqual(["employee.last_working_date"]);
  });
  it("decodes entities", () => expect(decodeEntities("A &amp; B &lt;3 &#8377; &#x20B9; &nbsp;x &unknown;")).toBe("A & B <3 ₹ ₹  x &unknown;"));
  it("turns HTML into styled blocks for the PDF", () => {
    const blocks = htmlToBlocks("<h2>Title</h2><p>Hello <strong>bold <em>both</em></strong> plain<br>next</p><ol><li>one</li><li>two</li></ol><ul><li>dot</li></ul>loose text");
    expect(blocks.map((b) => b.kind)).toEqual(["h2", "p", "li", "li", "li", "p"]);
    expect(blocks[1].runs).toEqual([{ text: "Hello " }, { text: "bold ", bold: true }, { text: "both", bold: true, italic: true }, { text: " plain" }, { text: "\n" }, { text: "next" }]);
    expect(blocks.slice(2, 5).map((b) => b.marker)).toEqual(["1.", "2.", "•"]);
    expect(blocks[5].runs[0].text).toBe("loose text");
  });
  it("skips empty paragraphs", () => expect(htmlToBlocks("<p> </p><p><br></p><div></div><p>x</p>")).toHaveLength(1));
});
