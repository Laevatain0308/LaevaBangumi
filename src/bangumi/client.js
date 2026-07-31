import * as existingBangumiClient from "../clients/bangumiClient.js";

export function createBangumiMetadataClient(httpClient = existingBangumiClient) {
  return {
    search(keyword) {
      return httpClient.searchSubjects(keyword);
    },
    getCalendar(...args) {
      return httpClient.getCalendar(...args);
    },
    getSubject(...args) {
      return httpClient.getSubject(...args);
    },
  };
}
