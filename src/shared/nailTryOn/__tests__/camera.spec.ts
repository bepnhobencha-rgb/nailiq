import { describe, expect, it, vi } from "vitest";
import {
  cameraStartMessage,
  REAR_CAMERA_CONSTRAINTS,
  stopMediaStream,
} from "@/shared/nailTryOn/camera";

describe("nail try-on camera", () => {
  it("requests the rear camera without audio", () => {
    expect(REAR_CAMERA_CONSTRAINTS).toEqual({
      audio: false,
      video: { facingMode: { ideal: "environment" } },
    });
  });

  it("stops every camera track", () => {
    const firstStop = vi.fn();
    const secondStop = vi.fn();

    stopMediaStream({
      getTracks: () => [
        { stop: firstStop } as unknown as MediaStreamTrack,
        { stop: secondStop } as unknown as MediaStreamTrack,
      ],
    });

    expect(firstStop).toHaveBeenCalledOnce();
    expect(secondStop).toHaveBeenCalledOnce();
  });

  it("explains permission denial without blocking photo upload", () => {
    expect(cameraStartMessage(new DOMException("denied", "NotAllowedError"))).toContain("choose a photo");
    expect(cameraStartMessage(new Error("camera unavailable"))).toContain("Use your device camera");
  });
});
