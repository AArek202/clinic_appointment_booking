import { ArgumentsHost, HttpStatus, NotFoundException } from '@nestjs/common';
import { ErrorCode } from '../errors/error-code.enum';
import { ConflictError } from '../errors/app.exception';
import { AllExceptionsFilter } from './all-exceptions.filter';

function hostWithResponse() {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }) }),
  } as unknown as ArgumentsHost;

  return { host, status, json };
}

describe('AllExceptionsFilter', () => {
  const filter = new AllExceptionsFilter();

  it('shapes an AppException into statusCode, code and message', () => {
    const { host, status, json } = hostWithResponse();

    filter.catch(
      new ConflictError(ErrorCode.SlotAlreadyBooked, 'Slot taken', {
        waitingListAvailable: true,
      }),
      host,
    );

    expect(status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(json).toHaveBeenCalledWith({
      statusCode: HttpStatus.CONFLICT,
      code: ErrorCode.SlotAlreadyBooked,
      message: 'Slot taken',
      waitingListAvailable: true,
    });
  });

  it('gives a plain Nest exception a sensible default code', () => {
    const { host, status, json } = hostWithResponse();

    filter.catch(new NotFoundException('Doctor not found'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(json).toHaveBeenCalledWith({
      statusCode: HttpStatus.NOT_FOUND,
      code: ErrorCode.NotFound,
      message: 'Doctor not found',
    });
  });

  it('never leaks internals from an unknown error', () => {
    const { host, status, json } = hostWithResponse();

    filter.catch(new Error('connection string: postgres://user:secret@host'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(json).toHaveBeenCalledWith({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCode.InternalError,
      message: 'Internal server error',
    });
  });
});
