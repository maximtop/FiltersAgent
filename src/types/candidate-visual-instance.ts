/**
 * One visual occurrence the candidate review cites: the schema every inventory, synthesis and
 * persisted review shares, kept apart from the review record so the records built on it can import
 * it without importing the review.
 */
import * as v from 'valibot';
import { ArtifactIdSchema } from './full-page-overview-evidence';

/**
 * Longest landmark one visual occurrence may name: enough for a page region in a sentence. The
 * synthesis context limit is derived from it, since every occurrence is sent there whole.
 */
export const MAX_INSTANCE_LANDMARK_CHARS = 500;

/**
 * Longest description of one visual occurrence. The synthesis context limit is derived from it,
 * since every occurrence is sent there whole.
 */
export const MAX_INSTANCE_DESCRIPTION_CHARS = 1_000;

/**
 * One visual occurrence tied to an exact runner-owned screenshot or tile artifact.
 *
 * Every field is required and checked; a key beside them is dropped rather than refused, because a
 * vision model annotates its instances (`landmark_note`) the same way it annotates a whole reply.
 */
export const CandidateVisualInstanceSchema = v.object({
    artifactId: ArtifactIdSchema,
    landmark: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_INSTANCE_LANDMARK_CHARS)),
    description: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_INSTANCE_DESCRIPTION_CHARS)),
});

/**
 * One visual symptom occurrence tied to an evidence artifact and page landmark.
 */
export type CandidateVisualInstance = v.InferOutput<typeof CandidateVisualInstanceSchema>;
