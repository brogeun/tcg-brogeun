// Existing PMD HitGround frames, drawn facing right. Source files stay unmodified.
// Every frame is rendered at a single uniform scale, never squeezed to fit a box.
export const SLIDE_POSES = {
  pikachu: { file: 'slide-pikachu-v1.png', frames: [[82, 5, 32, 19], [122, 9, 32, 19], [162, 8, 32, 19], [202, 9, 32, 19]] },
  charmander: { file: 'slide-charmander-v1.png', frames: [[81, 5, 32, 16], [121, 7, 32, 16], [161, 6, 32, 16], [201, 7, 32, 16]] },
  squirtle: { file: 'slide-squirtle-v1.png', frames: [[81, 6, 32, 13], [121, 10, 32, 13], [161, 9, 32, 13], [201, 10, 32, 13]] }
};
export function slideVisual(character, remaining) {
  const pose = SLIDE_POSES[character];
  const frame = Math.max(0, Math.min(pose.frames.length - 1, Math.floor((.32 - remaining) / .08)));
  const bounds = pose.frames[frame];
  return { bounds, width: bounds[2] * 3, height: bounds[3] * 3 };
}
