# TikTok Auto-Reply Gemini AI (`v1.0.7`)

Chrome Extension (Manifest V3) tự động quét và trả lời **Tin nhắn** & **Bình luận** trên **TikTok Business Suite** và **Hoạt động TikTok** trực tiếp bằng **Gemini API** (mặc định `gemini-3.8-flash`), không cần server trung gian.

## Tính năng chính
1. **Phần 1 — Tin nhắn (`tiktok.com/business-suite/messages`):**
   - Tương thích trực tiếp kiến trúc cross-iframe (`iframe[src*="/messages"]`, `[data-e2e="dm-new-conversation-list"]`, `[data-e2e="dm-new-chatbox"]`).
   - Quét **10 cuộc hội thoại gần nhất** (tùy chỉnh được), xác nhận đúng tiêu đề khách hàng trước khi đọc để tránh nhầm hội thoại.
   - Phân biệt tin khách (lề trái) vs tin kênh (lề phải): chỉ trả lời khi **tin cuối là của khách**; tự trích xuất ngữ cảnh video khách chia sẻ kèm + 12 tin lịch sử gần nhất.
   - Điền chuẩn Draft.js/Lexical bằng synthetic `paste`, tự bấm nút gửi máy bay giấy đỏ (`✈️`) và xác nhận gửi thành công (`isInputCleared`).
2. **Phần 2 — Bình luận (`tiktok.com/business-suite/comments` & `tiktok.com/vi-VN/`):**
   - Quét **5 video gần nhất** (`.infinite-scroll-component > div`), mở `iframe[src*="/video/"]`, cuộn chậm rãi chạm đáy danh sách bình luận để không sót bình luận lazy-load.
   - Tách từng bình luận theo `[data-e2e="comment-reply-1"]`, bỏ qua bình luận đã có `Xem X câu trả lời`, đọc đầy đủ tiêu đề + mô tả + hashtag video để trả lời đúng trọng tâm dịch vụ.
   - Quét lại DOM tươi sau mỗi câu trả lời, tự mở ô inline ngay dưới bình luận và bấm nút gửi mũi tên hồng (`⬆️`).
   - Hỗ trợ thêm quét mục **Hoạt động → Bình luận** trên trang chủ `tiktok.com`.
3. **Phân lịch độc lập & An toàn:**
   - Tách riêng chu kỳ **Quét Tin nhắn** (mặc định `20s`) và **Quét Bình luận** (mặc định `60s`), tự F5 làm mới trước mỗi vòng quét.
   - Có **Chế độ Nháp (Draft Mode)**, chống trả lời trùng (`dedupe` chỉ khóa khi đã gửi thật), giới hạn tốc độ gửi/phút (`15/phút`), nút **Test kết nối Gemini**, **Kiểm tra DOM**, và **Nhật ký** trực quan.

## Cài đặt nhanh
1. Clone repo hoặc tải thư mục `chrome-extension/`.
2. Mở Chrome $\rightarrow$ `chrome://extensions/` $\rightarrow$ bật **Developer mode**.
3. Chọn **Load unpacked** $\rightarrow$ trỏ vào thư mục `chrome-extension/`.
4. Mở Popup Extension $\rightarrow$ tab **Gemini AI** $\rightarrow$ dán **Gemini API Key** (Google AI Studio) $\rightarrow$ chọn model `gemini-3.8-flash` $\rightarrow$ bấm **Test kết nối Gemini** $\rightarrow$ chỉnh kịch bản & bảng giá $\rightarrow$ **Lưu cấu hình AI**.
5. Mở `https://www.tiktok.com/business-suite/messages?lang=vi-VN&from=homepage`, bỏ tick **Chế độ Nháp** và bật công tắc **ON**.
