export type ImportJobStatus =
  | "pending"
  | "scraping"
  | "extracting"
  | "building"
  | "done"
  | "failed";

export type ImportJob = {
  id: string;
  salon_id: string;
  source_url: string;
  status: ImportJobStatus;
  progress: number;
  result: ImportResult | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

export type ImportResult = {
  salonName: string;
  servicesImported: number;
  imagesDownloaded: number;
};

export const IMPORT_STATUS_LABELS: Record<ImportJobStatus, string> = {
  pending: "Queued",
  scraping: "Fetching website…",
  extracting: "Analysing content with AI…",
  building: "Importing data…",
  done: "Done",
  failed: "Failed",
};

export const IMPORT_STATUS_STEPS: ImportJobStatus[] = [
  "pending",
  "scraping",
  "extracting",
  "building",
  "done",
];
