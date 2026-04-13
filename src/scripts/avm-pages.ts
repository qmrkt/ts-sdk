const PROGRAM_PAGE_BYTES = 2048
const MAX_PROGRAM_PAGES = 4

export function programPageCount(byteLength: number): number {
  return Math.max(1, Math.ceil(byteLength / PROGRAM_PAGE_BYTES))
}

export function requiredExtraPages(...programs: Uint8Array[]): number {
  const totalProgramBytes = programs.reduce((totalBytes, program) => {
    return totalBytes + program.byteLength
  }, 0)
  return Math.max(0, programPageCount(totalProgramBytes) - 1)
}

export function fitsWithinMaxProgramPages(...programs: Uint8Array[]): boolean {
  const totalProgramBytes = programs.reduce((totalBytes, program) => {
    return totalBytes + program.byteLength
  }, 0)
  return programPageCount(totalProgramBytes) <= MAX_PROGRAM_PAGES
}
