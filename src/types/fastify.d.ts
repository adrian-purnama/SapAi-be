import type { ApiKeyAuthContext } from "./authContext.js";
import type { AppConfig } from "../config.js";

declare module "fastify" {
  interface FastifyInstance {
    config: AppConfig;
    startedAtMonotonic: number;
  }

  interface FastifyRequest {
    apiAuth?: ApiKeyAuthContext;
  }
}
