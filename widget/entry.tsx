import { mountMessenger } from "./messenger.js";
import { createOverlayTransport } from "./overlay-transport.js";

mountMessenger(createOverlayTransport());
