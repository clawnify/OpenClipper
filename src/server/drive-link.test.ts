import { describe, expect, it } from "vitest";
import {
  directDownloadUrl,
  isVideoName,
  judgeLinkResponse,
  parseDriveLink,
  parseFolderListing,
} from "./drive-link";

// Trimmed from the real embeddedfolderview HTML of a shared folder.
const FOLDER_HTML = `<div class="flip-entries"><div class="flip-entry" id="entry-11u7QUwMCWfj8CqykgaoJYrgZqv5p0o4j" tabindex="0" role="link"><div class="flip-entry-info"><a href="https://drive.google.com/file/d/11u7QUwMCWfj8CqykgaoJYrgZqv5p0o4j/view?usp=drive_web" target="_blank"><div class="flip-entry-visual"><div class="flip-entry-thumb"><img src="https://lh3.googleusercontent.com/drive-storage/AJQ=s190" alt="Video"/></div></div><div class="flip-entry-list-icon"><img src="https://drive-thirdparty.googleusercontent.com/16/type/video/mp4" alt=""/></div><div class="flip-entry-title">Cassiopeia Walkthrough v1.4.mp4</div></a></div><div class="flip-entry-last-modified"><div>Sep 18</div></div></div><div class="flip-entry" id="entry-1b77GaAF1fFuijjQYELSMYd48DxK3JzYA" tabindex="0" role="link"><div class="flip-entry-info"><a href="https://drive.google.com/file/d/1b77GaAF1fFuijjQYELSMYd48DxK3JzYA/view"><div class="flip-entry-title">Landlord &amp; Co Playthrough.mp4</div></a></div></div><div class="flip-entry" id="entry-1pK1BtJCxW3JXWWu4vH5CAs1crZyHWPCL"><div class="flip-entry-info"><a href="#"><div class="flip-entry-title">notes.pdf</div></a></div></div></div>`;

describe("parseDriveLink", () => {
  it("reads folder, file and download links", () => {
    expect(parseDriveLink("https://drive.google.com/drive/folders/11IGCXt8shsfXR1Sf-sqD9gPaoJAHz6Th?usp=sharing")).toEqual({
      kind: "folder",
      id: "11IGCXt8shsfXR1Sf-sqD9gPaoJAHz6Th",
    });
    expect(parseDriveLink("https://drive.google.com/file/d/11u7QUwMCWfj8CqykgaoJYrgZqv5p0o4j/view?usp=drive_web")).toEqual({
      kind: "file",
      id: "11u7QUwMCWfj8CqykgaoJYrgZqv5p0o4j",
    });
    expect(parseDriveLink("https://drive.usercontent.google.com/download?id=11u7QUwMCWfj8CqykgaoJYrgZqv5p0o4j&export=download")).toEqual({
      kind: "file",
      id: "11u7QUwMCWfj8CqykgaoJYrgZqv5p0o4j",
    });
    expect(parseDriveLink("https://drive.google.com/open?id=11u7QUwMCWfj8CqykgaoJYrgZqv5p0o4j")).toEqual({
      kind: "file",
      id: "11u7QUwMCWfj8CqykgaoJYrgZqv5p0o4j",
    });
  });

  it("ignores links that aren't Drive", () => {
    expect(parseDriveLink("https://example.com/file/d/abcdefghijkl/view")).toBeNull();
    expect(parseDriveLink("https://cdn.example.com/episode-12.mp4")).toBeNull();
    expect(parseDriveLink("not a url")).toBeNull();
  });
});

describe("directDownloadUrl", () => {
  it("keeps confirm=t, which is what skips the virus-scan page on big files", () => {
    expect(directDownloadUrl("abc123def456")).toBe(
      "https://drive.usercontent.google.com/download?id=abc123def456&export=download&confirm=t",
    );
  });
});

describe("parseFolderListing", () => {
  it("pulls every entry's id and name, decoding entities", () => {
    const files = parseFolderListing(FOLDER_HTML);
    expect(files).toEqual([
      { id: "11u7QUwMCWfj8CqykgaoJYrgZqv5p0o4j", name: "Cassiopeia Walkthrough v1.4.mp4" },
      { id: "1b77GaAF1fFuijjQYELSMYd48DxK3JzYA", name: "Landlord & Co Playthrough.mp4" },
      { id: "1pK1BtJCxW3JXWWu4vH5CAs1crZyHWPCL", name: "notes.pdf" },
    ]);
  });

  it("returns nothing for a page that isn't a folder listing", () => {
    expect(parseFolderListing("<html><body>Sorry, you need permission</body></html>")).toEqual([]);
  });

  it("knows which entries are video", () => {
    expect(parseFolderListing(FOLDER_HTML).filter((f) => isVideoName(f.name))).toHaveLength(2);
  });
});

describe("judgeLinkResponse", () => {
  it("accepts a ranged video reply and reads the real size from Content-Range", () => {
    expect(judgeLinkResponse(206, "video/mp4", "bytes 0-1/7498432963", "2")).toEqual({
      ok: true,
      contentType: "video/mp4",
      size: 7498432963,
    });
  });

  it("rejects the HTML Google serves when a file is over its download quota", () => {
    const out = judgeLinkResponse(200, "text/html; charset=utf-8", null, "2043");
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/downloaded too many times|isn't shared publicly/);
  });

  it("explains a private link instead of just failing", () => {
    expect(judgeLinkResponse(403, "text/html", null, null).reason).toMatch(/Anyone with the link/);
  });

  it("accepts an unlabelled binary, rejects a labelled non-video", () => {
    expect(judgeLinkResponse(200, "application/octet-stream", null, "123").ok).toBe(true);
    expect(judgeLinkResponse(200, "application/pdf", null, "123").ok).toBe(false);
  });
});
