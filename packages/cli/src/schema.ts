import {
  buildAgentApiSchema,
  routeExample,
  routeGroup,
  routeRequestShape,
  routeResponseShape,
  routeErrors,
  routeIdempotency,
  routeSideEffects,
  routeAuth,
  selectRoutes,
  validateRouteFilter,
  type RouteFilterOptions,
} from "@coolie/protocol"

export interface SchemaCliOptions extends RouteFilterOptions {
  readonly all?: boolean
  readonly json?: boolean
}

export const formatSchemaText = (options: SchemaCliOptions = {}): string => {
  validateRouteFilter(options)
  const lines: string[] = []
  for (const route of selectRoutes(options)) {
    const head = `${route.method} ${route.path}`
    lines.push(`${head.padEnd(28)} ${route.description}`)
    if (options.all) {
      lines.push(`  group: ${routeGroup(route)}`)
      lines.push(`  auth: ${routeAuth(route)}`)
      lines.push(`  request: ${routeRequestShape(route)}`)
      lines.push(`  response: ${routeResponseShape(route)}`)
      lines.push(`  errors: ${routeErrors(route).join(", ") || "none"}`)
      const idempotency = routeIdempotency(route)
      lines.push(`  idempotency: ${idempotency ?? "none"}`)
      lines.push(`  sideEffects: ${routeSideEffects(route)}`)
      lines.push(`  example: ${routeExample(route)}`)
    }
  }
  return lines.join("\n")
}

export const formatSchemaJson = (options: RouteFilterOptions = {}): string =>
  JSON.stringify(buildAgentApiSchema(options), null, 2)

export const renderSchema = (options: SchemaCliOptions = {}): string =>
  options.json ? formatSchemaJson(options) : formatSchemaText(options)
