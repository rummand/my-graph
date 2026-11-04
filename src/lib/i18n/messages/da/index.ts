/** Every namespace for this language, imported statically so nothing loads at runtime. */
import type { Dictionary } from "../../core";
import common from "./common";
import shell from "./shell";
import settings from "./settings";
import auth from "./auth";
import today from "./today";
import people from "./people";
import timeline from "./timeline";
import chat from "./chat";
import library from "./library";
import wiki from "./wiki";
import graph from "./graph";
import changes from "./changes";
import history from "./history";
import memory from "./memory";
import automations from "./automations";
import connections from "./connections";
import graphs from "./graphs";
import onboarding from "./onboarding";
import model from "./model";
import mention from "./mention";

const da: Dictionary = { common, shell, settings, auth, today, people, timeline, chat, library, wiki, graph, changes, history, memory, automations, connections, graphs, onboarding, model, mention };

export default da;
