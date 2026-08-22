/**
 * Monad brand palette, from https://www.monad.xyz/brand-and-media-kit
 *
 * Using the official colours is not decoration here. To an audience of Monad developers, this
 * palette reads as "a Monad project" on sight, and at an event judged by peer vote that
 * recognition is worth more than any amount of custom styling.
 *
 * ONE RULE THAT OVERRIDES THE BRAND: the traffic light itself stays true green and true red.
 * It is the game's only safety-critical signal — a player reads it in under a second and bets
 * their run on it. Purple owns everything else: chrome, buttons, track, headings, dots.
 */
export const MONAD = {
  /** Primary. Actions and anything that should read as "Monad". */
  purple: "#6E54FF",
  /** Secondary text and muted labels. */
  lightPurple: "#B7AAFF",
  /** Deep purple, for raised surfaces against the near-black. */
  deepPurple: "#200052",
  /** Page background. */
  black: "#0E091C",
  /** Accent. Used for one thing only — see `you` below. */
  cyan: "#85E6FF",
  /** Soft lavender for cards. */
  lavender: "#DDD7FE",
} as const;

/**
 * The traffic light. Deliberately NOT brand colours.
 *
 * These need to be unmistakable at a glance, from across a room, on a cheap phone screen in bad
 * lighting. Brand harmony is not worth a single player misreading the light.
 */
export const LIGHT = {
  green: "#22C55E",
  red: "#EF4444",
  unknown: "#3F3A52",
} as const;

export const PLAYER = {
  /** A live player's dot. */
  alive: "#4ADE80",
  /** Eliminated. */
  out: "#B91C1C",
  /** The winner. */
  won: "#FBBF24",
  /**
   * YOUR dot, in cyan.
   *
   * This is a usability requirement, not a flourish. With fifty dots on a projected racetrack, a
   * player who cannot find themselves within a second stops watching the screen and looks back at
   * their phone — which is exactly when they stop being part of the room.
   */
  you: MONAD.cyan,
} as const;
