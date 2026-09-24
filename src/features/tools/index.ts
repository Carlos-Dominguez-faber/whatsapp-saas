import { registry } from "./registry";
import { echoTool } from "./tools/echo";
import { scheduleLinkTool } from "./tools/schedule-link";
import { scheduleHighLevelTool } from "./tools/schedule-highlevel";
import { checkAvailabilityTool } from "./tools/check-availability";

registry.register(echoTool);
registry.register(scheduleLinkTool);
registry.register(scheduleHighLevelTool);
registry.register(checkAvailabilityTool);

export { registry };
export type {
  Tool,
  ToolContext,
  ToolResult,
  ToolSensitivity,
} from "./core/tool";
