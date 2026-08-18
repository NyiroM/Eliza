// scripts/verify-no-code-veto.mts
import assert from "node:assert/strict";
import * as noCodeModule from "../lib/pipeline/noCodeRoleVeto";
import * as fitModule from "../lib/scoring/fitScore";

type NoCodeApi = typeof import("../lib/pipeline/noCodeRoleVeto");
type FitApi = typeof import("../lib/scoring/fitScore");
const noCode: NoCodeApi =
  (noCodeModule as unknown as { default?: NoCodeApi }).default ?? (noCodeModule as unknown as NoCodeApi);
const fit: FitApi =
  (fitModule as unknown as { default?: FitApi }).default ?? (fitModule as unknown as FitApi);

const {
  userConstraintsRejectCodingWork,
  detectCodingCoreWork,
  inferNoCodeRoleVeto,
} = noCode;
const { collectConstraintSignalHints } = fit;

const CONSTRAINTS = [
  "I have zero coding experience and cannot write or read code. Hard veto software developer / SW developer roles and any job whose core work is writing algorithms or production code.",
];

assert.equal(userConstraintsRejectCodingWork(CONSTRAINTS), true);
assert.equal(userConstraintsRejectCodingWork(["I prefer hybrid with 2 remote days."]), false);
assert.equal(userConstraintsRejectCodingWork(["I cannot code."]), true);

const aidrive = `AI Research Engineer - aiDrive
As a Research Engineer in the Road Model team, you will take part in prototyping new solutions and you will see your code running in real cars.
Research, develop, implement, and test artificial intelligence algorithms to improve the quality and robustness of the static world model.
Strong Python programming and software design skills
Participate in designing the training and evaluation framework pipeline and perform code reviews
Experience in deep learning frameworks (Pytorch/Tensorflow)
`;

assert.ok(detectCodingCoreWork(aidrive));
const aidriveVeto = inferNoCodeRoleVeto(CONSTRAINTS, aidrive);
assert.equal(aidriveVeto.vetoed, true);
assert.match(aidriveVeto.veto_reason ?? "", /AI research|Python|code review|algorithm|Pytorch/i);

const thinTitle = "AI Research Engineer - aiDrive\nCompany: aiMotive\nLocation: Budapest, Hungary";
assert.equal(inferNoCodeRoleVeto(CONSTRAINTS, thinTitle).vetoed, true);

const sales = `Sales Engineer
Own a territory around Budapest. Conduct technical site surveys, coordinate with application engineers, and run Salesforce hygiene.
`;
assert.equal(inferNoCodeRoleVeto(CONSTRAINTS, sales).vetoed, false);

const salesMentionsAi = `Sales Engineer
Partner with our AI engineers to scope customer proofs of concept. No coding required.
`;
assert.equal(inferNoCodeRoleVeto(CONSTRAINTS, salesMentionsAi).vetoed, false);

const appEngineer = `Application Engineer - Business Development
Consultative discovery and ROI framing for industrial vacuum systems. Travel to customer sites.
`;
assert.equal(inferNoCodeRoleVeto(CONSTRAINTS, appEngineer).vetoed, false);

const silabsFaE = `Application Engineer II
Silicon Labs applications engineers provide engineering technical collateral like documentation, code examples, and customer technical support.
Providing technical support on complex MCU and peripheral related issues, which involves analyzing the system (architecture, code, execution), reproducing issues, and narrowing down to system parameters or embedded software component via gathering further evidence and designing additional tests (debugging).
Developing proof of concept designs and example code to showcase the competitive advantage of our products.
Strong embedded C programming skills: Ability to troubleshoot and debug code, devices, and systems
Understanding of embedded system concepts as well as sub-systems and peripherals (e.g. energy and clock management, timers, ADC, DAC, SPI, I2C, UART)
Use AI tools on a daily basis for coding, documentation and customer support task.
`;
const silabsVeto = inferNoCodeRoleVeto(CONSTRAINTS, silabsFaE);
assert.equal(silabsVeto.vetoed, true);
assert.match(
  silabsVeto.veto_reason ?? "",
  /hands-on software code|programming as a required skill|coding or software/i,
);

const supportDebugsC = `Customer Support Engineer
Help industrial clients bring up boards. You will read and debug customer firmware in C and reproduce issues on the bench.
`;
assert.equal(inferNoCodeRoleVeto(CONSTRAINTS, supportDebugsC).vetoed, true);

const mechApp = `Application Engineer
Specify pumps for food plants. Site surveys, BOM reviews, and commissioning with electricians. No software work.
`;
assert.equal(inferNoCodeRoleVeto(CONSTRAINTS, mechApp).vetoed, false);

const swDev = "Software Developer (Python)\nBuild REST APIs and review pull requests.";
assert.equal(inferNoCodeRoleVeto(CONSTRAINTS, swDev).vetoed, true);

assert.equal(inferNoCodeRoleVeto(["I like hybrid work."], aidrive).vetoed, false);

const hints = collectConstraintSignalHints(CONSTRAINTS, aidrive);
assert.ok(hints.some((h) => h.includes("NO_CODE_HARD_VETO")));

console.log("verify-no-code-veto: ok");
