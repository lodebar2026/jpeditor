// Subset of musicxml enums used by the score model (the rest lived in JAXB,
// now dropped). Values kept as strings matching MusicXML tokens.

export enum BarStyle {
  REGULAR = "regular",
  DOTTED = "dotted",
  DASHED = "dashed",
  HEAVY = "heavy",
  LIGHT_LIGHT = "light-light",
  LIGHT_HEAVY = "light-heavy",
  HEAVY_LIGHT = "heavy-light",
  HEAVY_HEAVY = "heavy-heavy",
  TICK = "tick",
  SHORT = "short",
  NONE = "none",
}

export enum StartStopDiscontinue {
  START = "start",
  STOP = "stop",
  DISCONTINUE = "discontinue",
}
