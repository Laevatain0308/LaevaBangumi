import * as existingBangumiClient from "../clients/bangumiClient.js";

export function createBangumiMetadataClient(httpClient = existingBangumiClient) {
  return {
    search(keyword, options = {}) {
      return httpClient.searchSubjects(keyword, { ...options, mediaType: "anime" });
    },
    getCalendar(...args) {
      return httpClient.getCalendar(...args);
    },
    getSubject(...args) {
      return httpClient.getSubject(...args);
    },
  };
}
