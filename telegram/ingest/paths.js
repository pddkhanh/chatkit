// chatkit — where the Telegram mirror keeps its files: <data>/telegram/.
import { join } from "node:path";
import { dataDir } from "../../lib/paths.js";

export const DATA = dataDir("telegram");
export const DB_PATH = join(DATA, "messages.db");
export const SESSION_PATH = join(DATA, "session");
