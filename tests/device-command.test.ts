import { describe, expect, it, vi } from 'vitest';

import type { XyteClient } from '../src/types/client';
import {
  prepareDeviceCommandBody,
  prepareModelBackedDeviceCommandBody,
  runDeviceCommandPollStep
} from '../src/workflows/device-command';

const COMMAND_POLL_CONFIG = {
  sendStepId: 'send',
  enabledKey: 'command_poll',
  intervalMsKey: 'command_poll_interval_ms',
  timeoutMsKey: 'command_poll_timeout_ms'
};

function commandTaskOutputs(modelData: unknown): ReadonlyMap<string, unknown> {
  return new Map([
    [
      'device',
      {
        endpointKey: 'organization.devices.getDevice',
        request: { path: { device_id: 'dev-1' } },
        response: { data: { id: 'dev-1', model: { id: 'model-1' } } }
      }
    ],
    [
      'model',
      {
        endpointKey: 'organization.models.getModel',
        request: { path: { id: 'model-1' } },
        response: { data: modelData }
      }
    ]
  ]);
}

function prepareWorkflowBody(args: {
  commands: unknown[];
  context?: Record<string, string>;
  command?: string;
}): unknown {
  const command = args.command ?? 'configure';
  return prepareDeviceCommandBody({
    endpointKey: 'organization.commands.sendCommand',
    stepId: 'send',
    context: args.context ?? {},
    taskOutputs: commandTaskOutputs({ commands: args.commands }),
    pathPayload: { device_id: 'dev-1' },
    bodyPayload: { command }
  });
}

function prepareDirectBody(commands: unknown[], bodyPayload: Record<string, unknown>): Record<string, unknown> {
  return prepareModelBackedDeviceCommandBody({
    evidence: {
      modelId: 'model-1',
      modelData: { commands }
    },
    bodyPayload
  });
}

describe('device command model validation', () => {
  it('applies canonical command context values through the shared validator', () => {
    const commands = [
      {
        name: 'configure',
        with_file: true,
        custom_fields: [
          {
            name: 'mode',
            type: 'select',
            required: true,
            options: { canonical: { label: 'Readable choice', value: 'canonical' } }
          }
        ]
      }
    ];

    expect(
      prepareWorkflowBody({
        commands,
        context: {
          command_extra_params_json: '{"mode":"Readable choice"}',
          command_file_id: 'file-1'
        }
      })
    ).toEqual({
      command: 'configure',
      extra_params: { mode: 'canonical' },
      file_id: 'file-1'
    });
  });

  it.each([
    {
      label: 'extra_params_json does not satisfy required parameters',
      commands: [{ name: 'configure', custom_fields: [{ name: 'mode', required: true }] }],
      context: { extra_params_json: '{"mode":"automatic"}', file_id: '' },
      expectedError: 'requires extra_params field(s): mode'
    },
    {
      label: 'file_id does not satisfy a file requirement',
      commands: [{ name: 'configure', with_file: true }],
      context: { extra_params_json: '', file_id: 'file-1' },
      expectedError: 'requires command_file_id'
    }
  ])('$label', ({ commands, context, expectedError }) => {
    expect(() => prepareWorkflowBody({ commands, context })).toThrow(expectedError);
  });

  it.each([
    {
      label: 'malformed embedded choices',
      field: { name: 'mode', type: 'select', required: false, options: 'invalid' },
      expectedError: 'invalid or ambiguous options metadata'
    },
    {
      label: 'unresolved path-backed choices',
      field: {
        name: 'mode',
        typeName: 'dynamicListSingle',
        required: false,
        path: 'details.available_modes'
      },
      expectedError: 'uses path-backed options'
    }
  ])('rejects omitted optional fields with $label', ({ field, expectedError }) => {
    expect(() =>
      prepareModelBackedDeviceCommandBody({
        evidence: {
          modelId: 'model-1',
          modelData: { commands: [{ name: 'configure', custom_fields: [field] }] }
        },
        bodyPayload: { command: 'configure' }
      })
    ).toThrow(expectedError);
  });

  it.each([
    { declared: { type: 'string' }, value: 'value' },
    { declared: { type: 'text' }, value: 'value' },
    { declared: { type: 'password' }, value: 'value' },
    { declared: { type: 'date' }, value: '2026-08-02' },
    { declared: { type: 'datetime' }, value: '2026-08-02T12:00:00Z' },
    { declared: { type: 'number' }, value: 1.25 },
    { declared: { typeName: 'integer' }, value: 2 },
    { declared: { type: 'boolean' }, value: false },
    { declared: { type: 'array' }, value: ['one'] },
    { declared: { type: 'object' }, value: { nested: true } },
    { declared: { type: 'json' }, value: { nested: true } }
  ])('accepts a supplied value matching declared metadata $declared', ({ declared, value }) => {
    expect(
      prepareDirectBody([{ name: 'configure', custom_fields: [{ name: 'value', required: true, ...declared }] }], {
        command: 'configure',
        extra_params: { value }
      })
    ).toEqual({ command: 'configure', extra_params: { value } });
  });

  it.each([
    { declared: { type: 'string', typeName: 'staticListSingle' }, optionValue: 'canonical' },
    { declared: { type: 'number', typeName: 'staticListSingle' }, optionValue: 42 },
    { declared: { type: 'boolean', typeName: 'staticListSingle' }, optionValue: false },
    { declared: { type: 'array', typeName: 'staticListMulti' }, optionValue: 'canonical' },
    { declared: { type: 'select' }, optionValue: 'canonical' },
    { declared: { type: 'multiselect' }, optionValue: 'canonical' },
    { declared: { typeName: 'staticListSingle' }, optionValue: 'canonical' },
    { declared: { typeName: 'staticListMulti' }, optionValue: 'canonical' }
  ])('accepts compatible option-backed metadata $declared', ({ declared, optionValue }) => {
    const multiple = declared.type === 'multiselect' || declared.typeName === 'staticListMulti';
    const input = multiple ? ['Readable choice'] : 'Readable choice';
    const expected = multiple ? [optionValue] : optionValue;

    expect(
      prepareDirectBody(
        [
          {
            name: 'configure',
            custom_fields: [
              {
                name: 'value',
                ...declared,
                options: [{ label: 'Readable choice', value: optionValue }]
              }
            ]
          }
        ],
        { command: 'configure', extra_params: { value: input } }
      )
    ).toEqual({ command: 'configure', extra_params: { value: expected } });
  });

  it.each([
    {
      label: 'scalar base type with multiple options',
      declared: { type: 'string', typeName: 'staticListMulti' },
      optionValue: 'canonical',
      input: ['Readable choice'],
      expectedError: 'is incompatible with multiple-value options'
    },
    {
      label: 'array base type with single options',
      declared: { type: 'array', typeName: 'staticListSingle' },
      optionValue: 'canonical',
      input: 'Readable choice',
      expectedError: 'is incompatible with single-value options'
    },
    {
      label: 'canonical option value with the wrong base type',
      declared: { type: 'string', typeName: 'staticListSingle' },
      optionValue: false,
      input: 'Readable choice',
      expectedError: 'match declared type "string"'
    },
    {
      label: 'unsupported secondary type metadata',
      declared: { type: 'string', typeName: 'unsupportedList' },
      optionValue: 'canonical',
      input: 'Readable choice',
      expectedError: 'declares unsupported typeName "unsupportedList"'
    }
  ])('rejects $label', ({ declared, optionValue, input, expectedError }) => {
    expect(() =>
      prepareDirectBody(
        [
          {
            name: 'configure',
            custom_fields: [
              {
                name: 'value',
                ...declared,
                options: [{ label: 'Readable choice', value: optionValue }]
              }
            ]
          }
        ],
        { command: 'configure', extra_params: { value: input } }
      )
    ).toThrow(expectedError);
  });

  it.each([
    { type: 'string', value: 1 },
    { type: 'number', value: Number.POSITIVE_INFINITY },
    { type: 'integer', value: 1.5 },
    { type: 'boolean', value: 'true' },
    { type: 'array', value: { zero: 'one' } },
    { type: 'json', value: ['not-an-object'] }
  ])('rejects a supplied value that does not match declared type $type', ({ type, value }) => {
    expect(() =>
      prepareDirectBody([{ name: 'configure', custom_fields: [{ name: 'value', type }] }], {
        command: 'configure',
        extra_params: { value }
      })
    ).toThrow(`match declared type "${type}"`);
  });

  it('fails closed on an unsupported declared type when a value is supplied', () => {
    expect(() =>
      prepareDirectBody([{ name: 'configure', custom_fields: [{ name: 'value', type: 'uuid' }] }], {
        command: 'configure',
        extra_params: { value: 'id-1' }
      })
    ).toThrow('declares unsupported type "uuid"');
  });

  it('fails closed on an unsupported declared type when an optional value is omitted', () => {
    expect(() =>
      prepareDirectBody([{ name: 'configure', custom_fields: [{ name: 'value', type: 'uuid', required: false }] }], {
        command: 'configure'
      })
    ).toThrow('declares unsupported type "uuid"');
  });

  it('retains untyped custom-field behavior', () => {
    const value = { nested: ['free-form'] };
    expect(
      prepareDirectBody([{ name: 'configure', custom_fields: [{ name: 'value' }] }], {
        command: 'configure',
        extra_params: { value }
      })
    ).toEqual({ command: 'configure', extra_params: { value } });
  });

  it.each([
    {
      label: 'friendly_name',
      command: { name: 'configure', friendly_name: 42 },
      expectedError: 'friendly_name must be a non-empty string'
    },
    {
      label: 'custom field type',
      command: { name: 'configure', custom_fields: [{ name: 'value', required: false, type: 42 }] },
      expectedError: 'type must be a non-empty string'
    },
    {
      label: 'custom field typeName',
      command: { name: 'configure', custom_fields: [{ name: 'value', required: false, typeName: null }] },
      expectedError: 'typeName must be a non-empty string'
    },
    {
      label: 'custom field path',
      command: { name: 'configure', custom_fields: [{ name: 'value', required: false, path: '   ' }] },
      expectedError: 'path must be a non-empty string'
    }
  ])(
    'rejects malformed present $label metadata even when no optional value is supplied',
    ({ command, expectedError }) => {
      expect(() => prepareDirectBody([command], { command: 'configure' })).toThrow(expectedError);
    }
  );
});

describe('device command polling provenance', () => {
  function makePollingClient(): { client: XyteClient; callWithMeta: ReturnType<typeof vi.fn> } {
    const callWithMeta = vi.fn(async () => ({
      status: 200,
      headers: {},
      data: { items: [{ id: 'cmd-1', status: 'done' }], has_next_page: false },
      durationMs: 1,
      retryCount: 0,
      attempts: 1
    }));
    return { client: { callWithMeta } as unknown as XyteClient, callWithMeta };
  }

  function pollContext(deviceId?: string): Record<string, string> {
    return {
      ...(deviceId === undefined ? {} : { device_id: deviceId }),
      command_poll: 'true',
      command_poll_interval_ms: '1',
      command_poll_timeout_ms: '100'
    };
  }

  function sendOutput(deviceId: unknown): unknown {
    return {
      request: { path: { device_id: deviceId } },
      response: { data: { id: 'cmd-1' } }
    };
  }

  it('polls the exact device id confirmed by the send envelope', async () => {
    const { client, callWithMeta } = makePollingClient();

    await expect(
      runDeviceCommandPollStep({
        stepId: 'poll',
        config: COMMAND_POLL_CONFIG,
        context: pollContext('confirmed-device'),
        sendOutput: sendOutput('confirmed-device'),
        client,
        tenantId: 'acme'
      })
    ).resolves.toMatchObject({ ok: true, output: { outcome: 'done', commandId: 'cmd-1' } });
    expect(callWithMeta).toHaveBeenCalledWith(
      'organization.commands.getCommands',
      expect.objectContaining({ path: { device_id: 'confirmed-device' } })
    );
  });

  it.each([
    {
      label: 'the send envelope omits device_id',
      context: pollContext('context-device'),
      output: sendOutput(undefined),
      expectedError: 'requires an exact non-empty device_id in send request.path'
    },
    {
      label: 'the send envelope has an empty device_id',
      context: pollContext('context-device'),
      output: sendOutput('   '),
      expectedError: 'requires an exact non-empty device_id in send request.path'
    },
    {
      label: 'resume context omits device_id',
      context: pollContext(),
      output: sendOutput('confirmed-device'),
      expectedError: 'requires context device_id to exactly match send request.path.device_id'
    },
    {
      label: 'resume context disagrees with the send envelope',
      context: pollContext('other-device'),
      output: sendOutput('confirmed-device'),
      expectedError: 'requires context device_id to exactly match send request.path.device_id'
    }
  ])('does not poll when $label', async ({ context, output, expectedError }) => {
    const { client, callWithMeta } = makePollingClient();

    await expect(
      runDeviceCommandPollStep({
        stepId: 'poll',
        config: COMMAND_POLL_CONFIG,
        context,
        sendOutput: output,
        client,
        tenantId: 'acme'
      })
    ).rejects.toThrow(expectedError);
    expect(callWithMeta).not.toHaveBeenCalled();
  });
});
