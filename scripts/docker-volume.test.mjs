import { describe, it, expect, afterEach } from "vitest";
import { resolveVolumeName } from "./docker-volume.mjs";

describe("resolveVolumeName", () => {
  afterEach(() => {
    delete process.env.MM_VOLUME_NAME;
  });

  it("honors the MM_VOLUME_NAME override without shelling out to docker", () => {
    process.env.MM_VOLUME_NAME = "some_explicit_volume";
    expect(resolveVolumeName()).toBe("some_explicit_volume");
  });
});
