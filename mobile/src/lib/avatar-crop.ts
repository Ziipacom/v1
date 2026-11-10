export type AvatarCropPosition = { x: number; y: number; zoom: number };

export const centeredAvatarCrop: AvatarCropPosition = {
  x: 0.5,
  y: 0.5,
  zoom: 1,
};
export const maxAvatarZoom = 4;

export function avatarCropRect(
  width: number,
  height: number,
  position: AvatarCropPosition,
) {
  const size = Math.max(1, Math.floor(Math.min(width, height) / position.zoom));
  const origin = (center: number, extent: number) =>
    Math.max(
      0,
      Math.min(extent - size, Math.round(center * extent - size / 2)),
    );
  return {
    originX: origin(position.x, width),
    originY: origin(position.y, height),
    width: size,
    height: size,
  };
}

export function moveAvatarCrop(
  width: number,
  height: number,
  position: AvatarCropPosition,
  dx: number,
  dy: number,
  frame: number,
): AvatarCropPosition {
  const rect = avatarCropRect(width, height, position);
  const bound = (center: number, extent: number) => {
    const margin = rect.width / (2 * extent);
    return Math.max(margin, Math.min(1 - margin, center));
  };
  return {
    ...position,
    x: bound(position.x - (dx * rect.width) / (frame * width), width),
    y: bound(position.y - (dy * rect.height) / (frame * height), height),
  };
}
