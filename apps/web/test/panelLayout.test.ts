import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("panel is a sibling of the views, not nested in #main", () => {
  it("index.html places #panel after #main closes (no longer inside it)", () => {
    const html = readFileSync(resolve(__dirname, "../index.html"), "utf8");
    const panelIdx = html.indexOf('id="panel"');
    const mainOpen = html.indexOf('id="main"');
    const mainClose = html.indexOf("</section>", mainOpen);
    expect(panelIdx).toBeGreaterThan(-1);
    expect(mainClose).toBeGreaterThan(-1);
    expect(panelIdx).toBeGreaterThan(mainClose); // panel no longer inside #main
  });
});
