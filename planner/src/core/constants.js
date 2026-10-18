// Frozen contract v1.0 values (guide sections 7 and 9). Do not change without
// the shared/changes/ process. Signal-model numbers live in shared/signal_model.json,
// NOT here.
export const DT_S = 0.5;               // fixed step, 2 Hz
export const MAX_ANCHOR_SLOTS = 8;     // model input slots
export const MIN_USABLE_ANCHORS = 3;   // blueprint coverage criterion, contract v1
export const CONTRACT_VERSION = "1.0";
export const ZONE_TYPES = Object.freeze(["crowd", "restricted", "priority", "normal"]);
export const SPLITS = Object.freeze(["train", "dev", "hidden"]);
export const VENUE_IDS = Object.freeze(["hospital", "warehouse", "office", "clinic"]);
export const RUN_ID_PATTERN = /^(hospital|warehouse|office|clinic)-(train|dev|hidden)-\d{4}$/;
