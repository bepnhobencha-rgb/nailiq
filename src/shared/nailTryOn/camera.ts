export const REAR_CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  audio: false,
  video: {
    facingMode: { ideal: "environment" },
    width: { ideal: 1920 },
    height: { ideal: 1080 },
  },
};

type StoppableStream = Pick<MediaStream, "getTracks">;

export function stopMediaStream(stream: StoppableStream | null) {
  stream?.getTracks().forEach((track) => track.stop());
}

export function cameraStartMessage(error: unknown) {
  return error instanceof DOMException && error.name === "NotAllowedError"
    ? "Camera permission was not granted. You can still use your device camera or choose a photo. / Chưa được cấp quyền camera. Bạn vẫn có thể dùng camera thiết bị hoặc chọn ảnh."
    : "We could not start the live camera. Use your device camera or choose a photo. / Chưa thể mở camera trực tiếp. Hãy dùng camera thiết bị hoặc chọn ảnh.";
}
