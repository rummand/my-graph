/**
 * People API (server): the overview of people around the family, profiles, check-ins and relationships.
 * For the assistant / daily brief: `peopleContext(viewer, personIds)` returns compact text.
 */
export { peopleOverview, personProfile, listObservations, viewerPersonId, visibleNode, canEditNode } from "./data";
export { createPerson, updatePerson, addRelation, addObservation, defaultVisibility, defaultObservationVisibility, PeopleError } from "./writes";
export type { CreatePersonInput, UpdatePersonInput, AddRelationInput, ObservationInput } from "./writes";
export { peopleContext, personLine, selfContext, selfLine } from "./context";
export { attentionItems, nextBirthday, DEFAULT_CADENCE } from "./attention";
export { canSee, canModify, visibleWhere } from "./access";
export * from "./types";
