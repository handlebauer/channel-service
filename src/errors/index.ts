export class AppError extends Error {
    constructor(
        message: string,
        public code: string,
    ) {
        super(message)
        this.name = this.constructor.name
        Error.captureStackTrace(this, this.constructor)
    }
}

export class ChannelError extends AppError {
    constructor(message = 'Channel operation failed') {
        super(message, 'CHANNEL_ERROR')
    }
}

export function handleError(error: unknown): AppError {
    if (error instanceof AppError) {
        return error
    }

    console.error('Unhandled error:', error)
    return new AppError('An unexpected error occurred', 'INTERNAL_SERVER_ERROR')
}
