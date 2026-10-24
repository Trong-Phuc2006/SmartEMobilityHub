import { normalizeEmail } from './auth.js'

export function validateAuthForm(mode, values) {
  const errors = {}
  const email = normalizeEmail(values.email)
  if (!email) errors.email = 'REQUIRED'
  else if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'INVALID_EMAIL'
  const length = [...values.password].length
  if (!length) errors.password = 'REQUIRED'
  else if (length < (mode === 'register' ? 8 : 1) || length > 128) errors.password = 'PASSWORD_LENGTH'
  if (mode === 'register') {
    if (!values.confirmPassword) errors.confirmPassword = 'REQUIRED'
    else if (values.password !== values.confirmPassword) errors.confirmPassword = 'PASSWORD_MISMATCH'
  }
  return errors
}

export function fieldMessage(code, mode) {
  return ({
    REQUIRED: 'Vui lòng nhập thông tin này.',
    INVALID_TYPE: 'Thông tin chưa hợp lệ.',
    INVALID_EMAIL: 'Vui lòng nhập email hợp lệ, tối đa 254 ký tự.',
    EMAIL_EXISTS: 'Email đã được đăng ký. Vui lòng đăng nhập.',
    PASSWORD_LENGTH: mode === 'register' ? 'Mật khẩu cần từ 8 đến 128 ký tự.' : 'Mật khẩu cần từ 1 đến 128 ký tự.',
    PASSWORD_MISMATCH: 'Mật khẩu xác nhận chưa khớp.',
  })[code] || 'Thông tin chưa hợp lệ.'
}

export function errorMessage(error) {
  return ({
    INVALID_CREDENTIALS: 'Email hoặc mật khẩu không đúng.',
    EMAIL_EXISTS: 'Email đã được đăng ký.',
    VALIDATION_ERROR: 'Vui lòng kiểm tra thông tin trong biểu mẫu.',
    ACCOUNT_DISABLED: 'Tài khoản không hoạt động.',
    ROLE_NOT_SUPPORTED: 'Tài khoản này chưa được hỗ trợ.',
    NETWORK_ERROR: 'Không thể kết nối máy chủ. Vui lòng kiểm tra kết nối và thử lại.',
    ORIGIN_NOT_ALLOWED: 'Địa chỉ truy cập chưa được máy chủ cho phép.',
    SERVICE_UNAVAILABLE: 'Dịch vụ tạm thời bận. Vui lòng thử lại.',
    UNEXPECTED_RESPONSE: 'Máy chủ phản hồi không hợp lệ. Vui lòng thử lại.',
  })[error?.code] || 'Không thể xử lý yêu cầu. Vui lòng thử lại.'
}

export function sessionMessage(code) {
  return ({
    SESSION_EXPIRED: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.',
    SESSION_INVALID: 'Phiên đăng nhập không hợp lệ. Vui lòng đăng nhập lại.',
    ACCOUNT_DISABLED: 'Tài khoản không hoạt động.',
    ROLE_NOT_SUPPORTED: 'Tài khoản này chưa được hỗ trợ.',
  })[code] || ''
}
