import { registry } from "./registry";
import { echoTool } from "./tools/echo";
import { scheduleLinkTool } from "./tools/schedule-link";
import { scheduleHighLevelTool } from "./tools/schedule-highlevel";
import { cancelHighLevelTool } from "./tools/cancel-highlevel";
import { rescheduleHighLevelTool } from "./tools/reschedule-highlevel";
import { listHighLevelAppointmentsTool } from "./tools/list-highlevel-appointments";
import { checkAvailabilityTool } from "./tools/check-availability";
import { handoffHumanTool } from "./tools/handoff-human";
import { listEventTypesCalComTool } from "./tools/list-event-types-calcom";
import { checkAvailabilityCalComTool } from "./tools/check-availability-calcom";
import { scheduleCalComTool } from "./tools/schedule-calcom";
import { cancelCalComTool } from "./tools/cancel-calcom";
import { rescheduleCalComTool } from "./tools/reschedule-calcom";
import { listCalComAppointmentsTool } from "./tools/list-calcom-appointments";

registry.register(echoTool);
registry.register(scheduleLinkTool);
registry.register(scheduleHighLevelTool);
registry.register(cancelHighLevelTool);
registry.register(rescheduleHighLevelTool);
registry.register(listHighLevelAppointmentsTool);
registry.register(checkAvailabilityTool);
registry.register(handoffHumanTool);
registry.register(listEventTypesCalComTool);
registry.register(checkAvailabilityCalComTool);
registry.register(scheduleCalComTool);
registry.register(cancelCalComTool);
registry.register(rescheduleCalComTool);
registry.register(listCalComAppointmentsTool);

export { registry };
export type {
  Tool,
  ToolContext,
  ToolResult,
  ToolSensitivity,
} from "./core/tool";
