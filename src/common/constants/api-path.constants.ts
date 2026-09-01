// src/common/constants/api-path.constants.ts

export const API_PREFIX = 'api/v1';

export const API_PATHS = {
  PUBLIC: `${API_PREFIX}/public`,
  PRIVATE: `${API_PREFIX}/private`,
} as const;
