import { createWidgetTransport } from "lucarne/widget/runtime";
import { mountMessenger } from "./messenger.js";

mountMessenger(createWidgetTransport({ ns: "vibewaiting" }));
