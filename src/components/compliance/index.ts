/** Compliance UI: live checks against the graph's corpora (wiki, documents, chat answers, change sets). */
export { ComplianceStrip, stripWords, type StripState } from "./strip";
export { FindingNote, FindingIcon, findingHeadline, severityTone } from "./finding-note";
export { ChangeSetCompliance } from "./change-set";
export { AnswerCompliance } from "./answer";
export { CheckAgainst, ReadCompliance } from "./wiki-side";
export { ArtifactCompliance, PublishCompliance, withAppendix, fixInContent } from "./artifact";
export { LiveWikiCompliance } from "./live-wiki";
