import { describe, expect, it } from "vitest";
import { wrapWords } from "./rules";

const w = (s: string) => s.length;
describe("certificate wrapping", () => {
  it("wraps by width", () => expect(wrapWords("one two three four", w, 9, 5)).toEqual(["one two", "three", "four"]));
  it("caps the lines with an ellipsis", () => expect(wrapWords("aa bb cc dd ee ff", w, 5, 2)).toEqual(["aa bb", "cc…"]));
  it("empty text gives no lines", () => expect(wrapWords("", w, 10, 3)).toEqual([]));
});
