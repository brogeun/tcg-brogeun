// Pure combat reach rules, shared by player input, impact checks and AI.
export function moveReach(move){return move.engine.range;}
export function withinMoveReach(actor,target,move){return actor.model.position.distanceTo(target.model.position)<=moveReach(move)+.001;}
export const CAPTURE_SAFETY_SECONDS=.7;