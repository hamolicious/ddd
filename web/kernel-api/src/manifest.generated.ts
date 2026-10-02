export const MANIFEST_KERNEL_VERSION = "3.1.0";

export interface PluginFrontend {
  readonly module: string;
  readonly style?: string;
}

export interface PluginCapabilities {
  readonly documents?: readonly ("read" | "write")[];
  readonly http?: HttpCapability;
  readonly notifications?: boolean;
  readonly "public-routes"?: readonly (string)[];
}

export interface HttpCapability {
  readonly hosts: readonly (string)[];
}

export interface PluginConfigField {
  readonly type: "string" | "number" | "boolean" | "select";
  readonly secret?: boolean;
  readonly label?: string;
  readonly description?: string;
  readonly default?: unknown;
  readonly required?: boolean;
  readonly options?: readonly (string)[];
}

export interface PluginBackend {
  readonly module: string;
  readonly hooks?: readonly ("document.created" | "document.changed" | "document.deleted")[];
  readonly cron?: readonly (string)[];
  readonly routes?: readonly (string)[];
  readonly events?: readonly (string)[];
  readonly exports?: Readonly<Record<string, BackendExport>>;
}

export interface BackendExport {
  readonly input?: unknown;
  readonly output?: unknown;
  readonly description?: string;
}

export interface PluginManifest {
  readonly id: string;
  readonly version: string;
  readonly kernel: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly provides?: string;
  readonly peerLibraries?: Readonly<Record<string, string>>;
  readonly frontend?: PluginFrontend;
  readonly capabilities?: PluginCapabilities;
  readonly config?: Readonly<Record<string, PluginConfigField>>;
  readonly backend?: PluginBackend;
  readonly name?: string;
  readonly description?: string;
  readonly author?: string;
  readonly license?: string;
  readonly [extension: `x-${string}`]: unknown;
}

export const MANIFEST_SCHEMA: ManifestSchemaNode = {
  "x-removed": {
    "consumes": "was removed in @kernel 3.0: import what you use from `plugin:<id>` and list the plugin under `dependencies`",
    "hot": "was removed in @kernel 3.0: every plugin change reloads the app",
    "x-defines": "was removed in @kernel 2.0: export a registration function (`addItem`) instead"
  },
  "type": "object",
  "required": [
    "id",
    "version",
    "kernel"
  ],
  "properties": {
    "id": {
      "type": "string",
      "format": "plugin-id"
    },
    "version": {
      "type": "string",
      "format": "semver"
    },
    "kernel": {
      "type": "string",
      "format": "semver-range"
    },
    "dependencies": {
      "type": "object",
      "propertyNames": {
        "format": "plugin-id"
      },
      "additionalProperties": {
        "type": "string",
        "format": "semver-range"
      }
    },
    "optionalDependencies": {
      "type": "object",
      "propertyNames": {
        "format": "plugin-id"
      },
      "additionalProperties": {
        "type": "string",
        "format": "semver-range"
      }
    },
    "provides": {
      "type": "string",
      "format": "plugin-ref"
    },
    "peerLibraries": {
      "type": "object",
      "additionalProperties": {
        "type": "string",
        "format": "semver-range"
      }
    },
    "frontend": {
      "$ref": "#/$defs/PluginFrontend"
    },
    "capabilities": {
      "$ref": "#/$defs/PluginCapabilities"
    },
    "config": {
      "type": "object",
      "additionalProperties": {
        "$ref": "#/$defs/PluginConfigField"
      }
    },
    "backend": {
      "$ref": "#/$defs/PluginBackend"
    },
    "name": {
      "type": "string"
    },
    "description": {
      "type": "string"
    },
    "author": {
      "type": "string"
    },
    "license": {
      "type": "string"
    }
  },
  "$defs": {
    "PluginFrontend": {
      "type": "object",
      "required": [
        "module"
      ],
      "properties": {
        "module": {
          "type": "string",
          "format": "relative-path"
        },
        "style": {
          "type": "string",
          "format": "relative-path"
        }
      }
    },
    "PluginCapabilities": {
      "type": "object",
      "properties": {
        "documents": {
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "read",
              "write"
            ]
          }
        },
        "http": {
          "$ref": "#/$defs/HttpCapability"
        },
        "notifications": {
          "type": "boolean"
        },
        "public-routes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "HttpCapability": {
      "type": "object",
      "properties": {
        "hosts": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "PluginConfigField": {
      "type": "object",
      "required": [
        "type"
      ],
      "properties": {
        "type": {
          "type": "string",
          "enum": [
            "string",
            "number",
            "boolean",
            "select"
          ]
        },
        "secret": {
          "type": "boolean"
        },
        "label": {
          "type": "string"
        },
        "description": {
          "type": "string"
        },
        "default": {},
        "required": {
          "type": "boolean"
        },
        "options": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "PluginBackend": {
      "type": "object",
      "x-removed": {
        "calls": "was removed in @kernel 3.0: list the callee under the manifest's `dependencies`"
      },
      "required": [
        "module"
      ],
      "properties": {
        "module": {
          "type": "string",
          "format": "relative-path"
        },
        "hooks": {
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "document.created",
              "document.changed",
              "document.deleted"
            ]
          }
        },
        "cron": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "routes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "events": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "exports": {
          "type": "object",
          "additionalProperties": {
            "$ref": "#/$defs/BackendExport"
          }
        }
      }
    },
    "BackendExport": {
      "type": "object",
      "properties": {
        "input": {},
        "output": {},
        "description": {
          "type": "string"
        }
      }
    }
  }
};

export interface ManifestSchemaNode {
  readonly $ref?: string;
  readonly type?: "object" | "array" | "string" | "number" | "integer" | "boolean";
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, ManifestSchemaNode>>;
  readonly additionalProperties?: ManifestSchemaNode | boolean;
  readonly propertyNames?: { readonly format?: string };
  readonly items?: ManifestSchemaNode;
  readonly enum?: readonly unknown[];
  readonly format?: string;
  readonly minimum?: number;
  readonly $defs?: Readonly<Record<string, ManifestSchemaNode>>;
  readonly "x-removed"?: Readonly<Record<string, string>>;
}
