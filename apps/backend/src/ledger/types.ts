/** Types shared by the ledger client and the Mithra layer. JSON shapes follow the JSON Ledger API v2. */

export interface CreateCommand {
  CreateCommand: { templateId: string; createArguments: Record<string, unknown> };
}

export interface ExerciseCommand {
  ExerciseCommand: {
    templateId: string;
    contractId: string;
    choice: string;
    choiceArgument: Record<string, unknown>;
  };
}

export type LedgerCommand = CreateCommand | ExerciseCommand;

/** A contract the submitter cannot see but may use, handed over by its owner (registry). */
export interface DisclosedContract {
  templateId: string;
  contractId: string;
  createdEventBlob: string;
  synchronizerId: string;
}

/** ACS_DELTA reports creates and archives; LEDGER_EFFECTS also reports exercises with results. */
export type TransactionShape = 'ACS_DELTA' | 'LEDGER_EFFECTS';

export interface CreatedEventView {
  kind: 'created';
  contractId: string;
  /** As sent by the ledger: `<packageId>:<Module>:<Entity>`. */
  templateId: string;
  /** `Module:Entity`, independent of the package id. */
  entity: string;
  createArgument: unknown;
  signatories: string[];
  observers: string[];
  createdAt: string;
  offset: number;
  createdEventBlob?: string;
  interfaceViews: InterfaceView[];
}

export interface ArchivedEventView {
  kind: 'archived';
  contractId: string;
  templateId: string;
  entity: string;
}

export interface ExercisedEventView {
  kind: 'exercised';
  contractId: string;
  templateId: string;
  entity: string;
  choice: string;
  choiceArgument: unknown;
  exerciseResult: unknown;
  consuming: boolean;
  actingParties: string[];
}

export type LedgerEvent = CreatedEventView | ArchivedEventView | ExercisedEventView;

export interface Transaction {
  updateId: string;
  commandId?: string;
  offset: number;
  effectiveAt: string;
  recordTime: string;
  synchronizerId: string;
  events: LedgerEvent[];
}

export interface InterfaceView {
  interfaceId: string;
  /** The interface view value, in Daml-LF JSON; null when the view could not be computed. */
  viewValue: unknown;
}

export interface ActiveContract {
  contractId: string;
  templateId: string;
  entity: string;
  /** The create arguments (the template payload) in Daml-LF JSON. */
  payload: unknown;
  signatories: string[];
  observers: string[];
  createdAt: string;
  offset: number;
  synchronizerId: string;
  createdEventBlob?: string;
  interfaceViews: InterfaceView[];
}

export interface SubmitInput {
  actAs: string[];
  readAs?: string[];
  commands: LedgerCommand[];
  disclosedContracts?: DisclosedContract[];
  /** Deduplication key. A retry of the same submission reuses it, so it is applied only once. */
  commandId?: string;
  /** Omit for the ledger default (ACS delta of the acting parties). */
  shape?: TransactionShape;
}

export interface ActiveContractsQuery {
  parties: string[];
  /** Template ids, `#mithra-v1:Module:Entity` or package-id form. */
  templateIds?: string[];
  /** Interface ids; the interface view arrives in `interfaceViews`. */
  interfaceIds?: string[];
  includeBlobs?: boolean;
}

export interface PartyDetails {
  party: string;
  isLocal: boolean;
}

export interface ConnectedSynchronizer {
  synchronizerAlias: string;
  synchronizerId: string;
}

/** `Module:Entity` of a template id (`<package>:<Module>:<Entity>` or `#name:<Module>:<Entity>`). */
export function entityOf(templateId: string): string {
  return templateId.split(':').slice(1).join(':');
}
