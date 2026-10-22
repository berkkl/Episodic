import { handleEpisodic, type EpisodicEnv } from "./episodic";
export { EpisodicQuota } from "./episodic-quota";

export default {
  async fetch(request: Request, env: EpisodicEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/") return Response.redirect(new URL("/episodic/", url).toString(), 302);
    if (url.pathname.startsWith("/api/episodic/")) {
      return handleEpisodic(request, env, url.pathname.replace(/\/+$/, ""));
    }
    return env.ASSETS.fetch(request);
  },
};
