import { errorEnvelope } from "../dto/errorDto.js";

function ts() {
  return new Date().toISOString();
}

function unauthorized(res) {
  return res.status(401).json(errorEnvelope(null, {
    updatedAt: ts(),
    message: "Missing or invalid account token",
    errorCode: "unauthorized",
  }));
}

export function createAccountAuthMiddleware({ accountService, logger = {} }) {
  const writeError = logger.error ?? (() => {});
  return function authenticateAccount(req, res, next) {
    const authorization = req.headers.authorization;
    const match = typeof authorization === "string"
      ? /^Bearer ([^\s,]+)$/.exec(authorization)
      : null;
    if (!match) return unauthorized(res);

    try {
      const auth = accountService.authenticate(match[1]);
      if (!auth) return unauthorized(res);
      req.accountAuth = auth;
      return next();
    } catch (error) {
      writeError("account-auth", "authentication failed", {
        message: error.message ?? String(error),
      });
      return res.status(500).json(errorEnvelope(null, {
        updatedAt: ts(),
        message: "Internal server error",
        errorCode: "server_error",
      }));
    }
  };
}
