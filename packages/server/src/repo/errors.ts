import { Data } from "effect"

export class ValidationError extends Data.TaggedError("ValidationError")<{ message: string }> {}
export class ConflictError extends Data.TaggedError("ConflictError")<{ message: string }> {}
export class NotFoundError extends Data.TaggedError("NotFoundError")<{ message: string }> {}
