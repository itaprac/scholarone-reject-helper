// Zachowane dla zgodności ze starymi skryptami npm i zapisanymi komendami.
// Właściwy punkt wejścia to bin/scholarone.js.
import { runReject } from "./run-reject.js";

await runReject(process.argv.slice(2));
