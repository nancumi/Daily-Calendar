import React, { useState, useEffect, useRef } from 'react';
import { 
  collection, 
  addDoc, 
  query, 
  where, 
  onSnapshot, 
  orderBy,
  getDocFromServer,
  doc,
  updateDoc,
  deleteDoc,
  Timestamp,
  getDocs,
  getDoc,
  setDoc
} from 'firebase/firestore';
import { 
  format, 
  startOfMonth, 
  endOfMonth, 
  startOfWeek, 
  endOfWeek, 
  eachDayOfInterval, 
  isSameMonth, 
  isSameDay, 
  addMonths, 
  subMonths 
} from 'date-fns';
import { ko } from 'date-fns/locale';
import { db } from './firebase';
import { Plus, Calendar as CalendarIcon, Loader2, ChevronLeft, ChevronRight, ArrowLeft, RefreshCw, Settings, Bell, X, Check } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface EventData {
  id: string;
  content: string;
  date: string;
  createdAt: string;
  completed?: boolean;
}

export default function App() {
  const [view, setView] = useState<'daily' | 'monthly'>('daily');
  const [content, setContent] = useState('');
  const [events, setEvents] = useState<EventData[]>([]);
  const [allEvents, setAllEvents] = useState<EventData[]>([]);
  const [loading, setLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [isPopupOpen, setIsPopupOpen] = useState(false);
  const [longPressedEvent, setLongPressedEvent] = useState<EventData | null>(null);
  const [editingEvent, setEditingEvent] = useState<EventData | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editDate, setEditDate] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>('default');
  const [lastNotifiedTime, setLastNotifiedTime] = useState<number>(0);
  const [userId, setUserId] = useState<string>('');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [notificationInterval, setNotificationInterval] = useState<number>(180);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const popupInputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  const today = format(new Date(), 'yyyy-MM-dd');

  useEffect(() => {
    // Generate or retrieve userId
    let storedUserId = localStorage.getItem('calendar_user_id');
    if (!storedUserId) {
      storedUserId = 'user_' + Math.random().toString(36).substring(2, 15);
      localStorage.setItem('calendar_user_id', storedUserId);
    }
    setUserId(storedUserId);

    const testConnection = async () => {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
      } catch (error) {
        if (error instanceof Error && error.message.includes('the client is offline')) {
          console.error("Please check your Firebase configuration.");
        }
      }
    };
    testConnection();

    // Register Service Worker and Subscribe to Push
    const setupPush = async () => {
      if ('serviceWorker' in navigator && 'PushManager' in window) {
        try {
          const registration = await navigator.serviceWorker.register('/sw.js');
          console.log('Service Worker registered');

          // Fetch current settings from Firestore
          const subDocRef = doc(db, 'push_subscriptions', storedUserId);
          const subDocSnap = await getDoc(subDocRef);
          if (subDocSnap.exists()) {
            const data = subDocSnap.data();
            if (data.notificationInterval) {
              setNotificationInterval(data.notificationInterval);
            }
          }

          // Request notification permission
          const permission = await Notification.requestPermission();
          setNotificationPermission(permission);

          if (permission === 'granted') {
            // Get VAPID public key from server
            const response = await fetch('/api/vapid-public-key');
            const { publicKey } = await response.json();

            // Subscribe to push
            const subscription = await registration.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: publicKey
            });

            // Send subscription to server
            await fetch('/api/save-subscription', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ subscription, userId: storedUserId })
            });
            console.log('Push subscription saved');
          }
        } catch (error) {
          console.error('Error setting up push:', error);
        }
      }
    };
    setupPush();
  }, []);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        const now = Date.now();
        const cooldown = 180 * 60 * 1000; // 180분 (밀리초 단위)

        const pendingTasks = events.filter(e => !e.completed);
        
        // 미완료 일정이 있고, 권한이 있으며, 마지막 알림 후 180분이 지났을 때만 발송
        if (pendingTasks.length > 0 && notificationPermission === 'granted' && (now - lastNotifiedTime > cooldown)) {
          new Notification('오늘의 일정을 확인하세요!', {
            body: `아직 완료하지 않은 일정이 ${pendingTasks.length}개 있습니다.`,
            icon: '/favicon.ico'
          });
          setLastNotifiedTime(now); // 알림 발송 시간 기록
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [events, notificationPermission]);

  useEffect(() => {
    if (!userId) return;

    // Listen for today's events for this user
    const qToday = query(
      collection(db, 'events'),
      where('userId', '==', userId),
      where('date', '==', today),
      orderBy('createdAt', 'desc')
    );

    const unsubscribeToday = onSnapshot(qToday, (snapshot) => {
      const eventList = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as EventData[];
      setEvents(eventList);
      setLoading(false);
    }, (error) => {
      console.error('Firestore Error:', error);
      setLoading(false);
    });

    // Listen for all events for this user to show dots on calendar
    const qAll = query(
      collection(db, 'events'), 
      where('userId', '==', userId),
      orderBy('createdAt', 'desc')
    );
    const unsubscribeAll = onSnapshot(qAll, (snapshot) => {
      const eventList = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as EventData[];
      setAllEvents(eventList);
    });

    return () => {
      unsubscribeToday();
      unsubscribeAll();
    };
  }, [today, userId]);

  const handleRegister = async (e?: React.FormEvent, targetDate: string = today, isPopup: boolean = false) => {
    if (e) e.preventDefault();
    const text = isPopup ? content : content; // Both use the same state for simplicity, or separate if needed
    if (!content.trim() || isSubmitting) return;

    setIsSubmitting(true);
    try {
      await addDoc(collection(db, 'events'), {
        content: content.trim(),
        date: targetDate,
        createdAt: new Date().toISOString(),
        completed: false,
        userId: userId
      });
      setContent('');
      if (isPopup) {
        setIsPopupOpen(false);
      } else {
        inputRef.current?.focus();
      }
    } catch (error) {
      console.error('Error adding event:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      const qToday = query(
        collection(db, 'events'),
        where('userId', '==', userId),
        where('date', '==', today),
        orderBy('createdAt', 'desc')
      );
      const snapshot = await getDocs(qToday);
      const eventList = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as EventData[];
      setEvents(eventList);
      
      // Also refresh all events for calendar dots
      const qAll = query(
        collection(db, 'events'), 
        where('userId', '==', userId),
        orderBy('createdAt', 'desc')
      );
      const snapshotAll = await getDocs(qAll);
      const eventListAll = snapshotAll.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as EventData[];
      setAllEvents(eventListAll);
    } catch (error) {
      console.error('Error refreshing events:', error);
    } finally {
      setTimeout(() => setIsRefreshing(false), 500); // Small delay for visual feedback
    }
  };

  const handleToggleComplete = async (event: EventData) => {
    try {
      await updateDoc(doc(db, 'events', event.id), {
        completed: !event.completed
      });
      setLongPressedEvent(null);
    } catch (error) {
      console.error('Error toggling complete:', error);
    }
  };

  const handleDelete = async (event: EventData) => {
    try {
      await deleteDoc(doc(db, 'events', event.id));
      setLongPressedEvent(null);
    } catch (error) {
      console.error('Error deleting event:', error);
    }
  };

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingEvent || !editContent.trim() || !editDate) return;

    try {
      await updateDoc(doc(db, 'events', editingEvent.id), {
        content: editContent.trim(),
        date: editDate
      });
      setEditingEvent(null);
      setEditContent('');
      setEditDate('');
    } catch (error) {
      console.error('Error updating event:', error);
    }
  };

  const handleSaveSettings = async () => {
    if (!userId || isSavingSettings) return;
    setIsSavingSettings(true);
    try {
      await setDoc(doc(db, 'push_subscriptions', userId), {
        notificationInterval: notificationInterval,
        updatedAt: new Date().toISOString()
      }, { merge: true });
      setIsSettingsOpen(false);
    } catch (error) {
      console.error('Error saving settings:', error);
      alert('설정 저장 중 오류가 발생했습니다.');
    } finally {
      setIsSavingSettings(false);
    }
  };



  const openPopup = (date: string) => {
    setSelectedDate(date);
    setIsPopupOpen(true);
    setTimeout(() => popupInputRef.current?.focus(), 100);
  };

  const handleDateClick = (date: string) => {
    setSelectedDate(date);
  };

  const renderCalendar = () => {
    const monthStart = startOfMonth(currentMonth);
    const monthEnd = endOfMonth(monthStart);
    const startDate = startOfWeek(monthStart);
    const endDate = endOfWeek(monthEnd);

    const calendarDays = eachDayOfInterval({
      start: startDate,
      end: endDate,
    });

    const rows = [];
    let days = [];

    calendarDays.forEach((day, i) => {
      const formattedDate = format(day, 'yyyy-MM-dd');
      const hasEvents = allEvents.some(e => e.date === formattedDate);
      const isToday = isSameDay(day, new Date());
      const isSelected = selectedDate === formattedDate;

      days.push(
        <div
          key={day.toString()}
          onClick={() => handleDateClick(formattedDate)}
          className={`relative h-14 sm:h-20 border-t border-l border-white/5 flex flex-col items-center justify-center transition-colors cursor-pointer hover:bg-white/5 ${
            !isSameMonth(day, monthStart) ? 'text-zinc-700' : 'text-zinc-300'
          } ${isToday ? 'bg-sky-500/10' : ''} ${isSelected ? 'ring-2 ring-inset ring-sky-500/50 bg-sky-500/5' : ''}`}
        >
          <span className={`text-sm ${isToday ? 'text-sky-400 font-bold' : ''} ${isSelected ? 'text-sky-400' : ''}`}>
            {format(day, 'd')}
          </span>
          {hasEvents && (
            <div className="mt-1 w-1 h-1 rounded-full bg-sky-500 shadow-[0_0_8px_rgba(14,165,233,0.5)]" />
          )}
        </div>
      );

      if ((i + 1) % 7 === 0) {
        rows.push(
          <div key={i} className="grid grid-cols-7 border-r border-white/5">
            {days}
          </div>
        );
        days = [];
      }
    });

    return (
      <div className="bg-zinc-900/20 border border-white/5 rounded-3xl overflow-hidden">
        <div className="grid grid-cols-7 bg-zinc-900/50 border-b border-white/5">
          {['일', '월', '화', '수', '목', '금', '토'].map(d => (
            <div key={d} className="py-3 text-center text-[10px] font-bold text-zinc-500 uppercase tracking-widest">
              {d}
            </div>
          ))}
        </div>
        {rows}
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-zinc-100 font-sans selection:bg-sky-500/30 relative">
      {/* Registration Popup */}
      <AnimatePresence>
        {isPopupOpen && selectedDate && (
          <div className="fixed inset-0 z-50 flex justify-center items-start pt-10 px-6 bg-black/60 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, y: -50 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -50 }}
              className="w-full max-w-lg bg-zinc-900 border border-white/10 rounded-3xl p-6 shadow-2xl"
            >
              <div className="mb-4">
                <h3 className="text-lg font-medium text-white">
                  {format(new Date(selectedDate), 'yyyy년 M월 d일')}
                </h3>
              </div>
              <form onSubmit={(e) => handleRegister(e, selectedDate, true)} className="space-y-4">
                <input
                  ref={popupInputRef}
                  type="text"
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="할 일을 입력하세요..."
                  className="w-full bg-zinc-800 border border-white/10 rounded-2xl px-6 py-4 text-lg focus:outline-none focus:ring-2 focus:ring-sky-500/50 transition-all"
                  disabled={isSubmitting}
                />
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="submit"
                    disabled={!content.trim() || isSubmitting}
                    className="w-full bg-sky-600 hover:bg-sky-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white py-4 rounded-2xl font-medium transition-all flex items-center justify-center gap-2"
                  >
                    {isSubmitting ? (
                      <Loader2 className="w-5 h-5 animate-spin" />
                    ) : (
                      <Plus className="w-5 h-5" />
                    )}
                    <span>등록하기</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsPopupOpen(false)}
                    className="w-full bg-zinc-800 hover:bg-zinc-700 text-zinc-300 py-4 rounded-2xl font-medium transition-all flex items-center justify-center"
                  >
                    취소
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Long Press Menu */}
      <AnimatePresence>
        {longPressedEvent && (
          <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center p-4 sm:p-6">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setLongPressedEvent(null)}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.div
              initial={{ opacity: 0, y: 100, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 100, scale: 0.95 }}
              className="relative w-full max-w-sm bg-zinc-900 border border-white/10 rounded-3xl overflow-hidden shadow-2xl"
            >
              <div className="p-6 border-b border-white/5">
                <h3 className="text-zinc-400 text-xs font-bold uppercase tracking-widest mb-2">작업 선택</h3>
                <p className="text-white font-medium truncate">{longPressedEvent.content}</p>
              </div>
              <div className="p-2">
                <button
                  onClick={() => handleToggleComplete(longPressedEvent)}
                  className="w-full flex items-center gap-3 px-4 py-4 text-zinc-300 hover:bg-white/5 rounded-xl transition-colors"
                >
                  <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${longPressedEvent.completed ? 'bg-sky-500 border-sky-500' : 'border-zinc-700'}`}>
                    {longPressedEvent.completed && <Plus className="w-3 h-3 text-white rotate-45" />}
                  </div>
                  <span>{longPressedEvent.completed ? '완료 취소' : '완료 처리'}</span>
                </button>
                <button
                  onClick={() => {
                    setEditingEvent(longPressedEvent);
                    setEditContent(longPressedEvent.content);
                    setEditDate(longPressedEvent.date);
                    setLongPressedEvent(null);
                  }}
                  className="w-full flex items-center gap-3 px-4 py-4 text-zinc-300 hover:bg-white/5 rounded-xl transition-colors"
                >
                  <CalendarIcon className="w-5 h-5 text-zinc-500" />
                  <span>수정하기</span>
                </button>
                <button
                  onClick={() => handleDelete(longPressedEvent)}
                  className="w-full flex items-center gap-3 px-4 py-4 text-rose-400 hover:bg-rose-400/10 rounded-xl transition-colors"
                >
                  <Plus className="w-5 h-5 rotate-45" />
                  <span>삭제하기</span>
                </button>
              </div>
              <button
                onClick={() => setLongPressedEvent(null)}
                className="w-full py-4 text-zinc-500 text-sm font-medium hover:bg-white/5 transition-colors"
              >
                닫기
              </button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Edit Modal */}
      <AnimatePresence>
        {editingEvent && (
          <div className="fixed inset-0 z-[110] flex items-start justify-center p-4 sm:p-6 pt-20">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setEditingEvent(null)}
              className="absolute inset-0 bg-black/80 backdrop-blur-md"
            />
            <motion.div
              initial={{ opacity: 0, y: -50 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -50 }}
              onAnimationComplete={() => {
                if (editInputRef.current) {
                  editInputRef.current.focus();
                  editInputRef.current.select();
                }
              }}
              className="relative w-full max-w-lg bg-zinc-900 border border-white/10 rounded-3xl shadow-2xl overflow-hidden"
            >
              <div className="p-8">
                <div className="flex items-center justify-between mb-8">
                  <h2 className="text-2xl font-light text-white">내역 <span className="font-medium text-sky-400">수정</span></h2>
                  <button 
                    onClick={() => setEditingEvent(null)}
                    className="p-2 hover:bg-white/5 rounded-full transition-colors"
                  >
                    <Plus className="w-6 h-6 text-zinc-500 rotate-45" />
                  </button>
                </div>
                <form onSubmit={handleUpdate} className="space-y-6">
                  <div className="space-y-2">
                    <label className="text-xs font-bold text-zinc-500 uppercase tracking-widest ml-1">내용</label>
                    <input
                      ref={editInputRef}
                      type="text"
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      placeholder="내용을 입력하세요"
                      className="w-full bg-zinc-800/50 border border-white/10 rounded-2xl px-6 py-5 text-lg text-white focus:outline-none focus:ring-2 focus:ring-sky-500/50 transition-all"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-bold text-zinc-500 uppercase tracking-widest ml-1">날짜</label>
                    <input
                      type="date"
                      value={editDate}
                      onChange={(e) => setEditDate(e.target.value)}
                      className="w-full bg-zinc-800/50 border border-white/10 rounded-2xl px-6 py-5 text-lg text-white focus:outline-none focus:ring-2 focus:ring-sky-500/50 transition-all [color-scheme:dark]"
                    />
                  </div>
                  <div className="flex gap-3 pt-4">
                    <button
                      type="submit"
                      className="flex-1 bg-sky-600 hover:bg-sky-500 text-white py-4 rounded-2xl font-medium transition-all shadow-lg shadow-sky-900/20"
                    >
                      저장하기
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingEvent(null)}
                      className="flex-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 py-4 rounded-2xl font-medium transition-all"
                    >
                      취소
                    </button>
                  </div>
                </form>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Settings Modal */}
      <AnimatePresence>
        {isSettingsOpen && (
          <div className="fixed inset-0 z-[110] flex items-center justify-center p-6 bg-black/80 backdrop-blur-md">
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="w-full max-w-md bg-zinc-900 border border-white/10 rounded-[32px] overflow-hidden shadow-2xl"
            >
              <div className="p-8 border-b border-white/5 flex items-center justify-between">
                <div>
                  <h3 className="text-xl font-medium text-white flex items-center gap-2">
                    <Settings className="w-5 h-5 text-sky-400" />
                    알림 설정
                  </h3>
                  <p className="text-zinc-500 text-xs mt-1 uppercase tracking-widest font-bold">Notification Settings</p>
                </div>
                <button 
                  onClick={() => setIsSettingsOpen(false)}
                  className="p-2 hover:bg-white/5 rounded-full transition-colors"
                >
                  <X className="w-6 h-6 text-zinc-500" />
                </button>
              </div>

              <div className="p-8 space-y-8">
                <div className="space-y-4">
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm font-medium text-zinc-300 flex items-center gap-2">
                      <Bell className="w-4 h-4 text-sky-400" />
                      알림 간격 (분)
                    </label>
                    <span className="text-sky-400 font-mono font-bold bg-sky-400/10 px-3 py-1 rounded-full text-xs">
                      {Math.floor(notificationInterval / 60)}시간 {notificationInterval % 60}분
                    </span>
                  </div>
                  <input
                    type="range"
                    min="1"
                    max="1440"
                    step="1"
                    value={notificationInterval}
                    onChange={(e) => setNotificationInterval(parseInt(e.target.value))}
                    className="w-full h-2 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-sky-500"
                  />
                  <div className="flex justify-between text-[10px] text-zinc-600 font-bold uppercase tracking-tighter">
                    <span>1분</span>
                    <span>12시간</span>
                    <span>24시간</span>
                  </div>
                  <div className="bg-zinc-800/50 border border-white/5 rounded-2xl p-4 mt-4">
                    <p className="text-xs text-zinc-400 leading-relaxed">
                      설정한 시간마다 미완료된 일정이 있는지 확인하여 알림을 보냅니다. 
                      <span className="block mt-1 text-sky-400/70 font-medium">* 최소 1분에서 최대 1440분(24시간)까지 설정 가능합니다.</span>
                    </p>
                  </div>
                </div>

                <div className="flex gap-3 pt-4">
                  <button
                    onClick={handleSaveSettings}
                    disabled={isSavingSettings}
                    className="flex-1 bg-sky-600 hover:bg-sky-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white py-4 rounded-2xl font-medium transition-all flex items-center justify-center gap-2 shadow-lg shadow-sky-900/20"
                  >
                    {isSavingSettings ? (
                      <Loader2 className="w-5 h-5 animate-spin" />
                    ) : (
                      <Check className="w-5 h-5" />
                    )}
                    <span>설정 저장</span>
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <div className="max-w-2xl mx-auto px-6 py-5">
        <AnimatePresence mode="wait">
          {view === 'daily' ? (
            <motion.div
              key="daily"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              transition={{ duration: 0.3 }}
              onAnimationComplete={() => {
                if (!isPopupOpen) {
                  inputRef.current?.focus();
                }
              }}
            >
              {/* Header */}
              <header className="mb-12 flex items-center justify-between">
                <div>
                  <h1 className="text-3xl font-light tracking-tight text-white mb-2">
                    Daily <span className="font-medium text-sky-400">Calendar</span>
                  </h1>
                  <p className="text-zinc-500 text-sm font-medium tracking-tight">
                    {format(new Date(), 'yyyy년 M월 d일 EEEE', { locale: ko })}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button 
                    onClick={() => setIsSettingsOpen(true)}
                    className="p-3 bg-zinc-900/50 border border-white/5 rounded-2xl hover:bg-zinc-800 transition-colors group"
                  >
                    <Settings className="w-6 h-6 text-zinc-500 group-hover:text-sky-400 group-hover:rotate-90 transition-all duration-300" />
                  </button>
                  <button 
                    onClick={() => {
                      setSelectedDate(today);
                      setView('monthly');
                    }}
                    className="p-3 bg-zinc-900/50 border border-white/5 rounded-2xl hover:bg-zinc-800 transition-colors group"
                  >
                    <CalendarIcon className="w-6 h-6 text-sky-400 group-hover:scale-110 transition-transform" />
                  </button>
                </div>
              </header>

              {/* Input Section */}
              <section className="mb-[30px]">
                <form onSubmit={(e) => handleRegister(e)} className="flex flex-col gap-4">
                  <input
                    ref={inputRef}
                    type="text"
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    placeholder="오늘의 할 일을 입력하세요..."
                    className="w-full bg-zinc-900/40 border border-white/10 rounded-2xl px-6 py-5 text-lg focus:outline-none focus:ring-2 focus:ring-sky-500/50 focus:border-sky-500/50 transition-all placeholder:text-zinc-600"
                    disabled={isSubmitting}
                  />
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      type="submit"
                      disabled={!content.trim() || isSubmitting}
                      className="w-full bg-sky-600 hover:bg-sky-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white py-4 rounded-2xl font-medium transition-all flex items-center justify-center gap-2 shadow-lg shadow-sky-900/20"
                    >
                      {isSubmitting ? (
                        <Loader2 className="w-5 h-5 animate-spin" />
                      ) : (
                        <Plus className="w-5 h-5" />
                      )}
                      <span>등록</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleRefresh}
                      disabled={isRefreshing}
                      className="w-full bg-zinc-800 hover:bg-zinc-700 disabled:text-zinc-600 text-zinc-300 py-4 rounded-2xl font-medium transition-all flex items-center justify-center gap-2"
                    >
                      {isRefreshing ? (
                        <Loader2 className="w-5 h-5 animate-spin" />
                      ) : (
                        <RefreshCw className="w-5 h-5" />
                      )}
                      <span>불러오기</span>
                    </button>
                  </div>
                </form>
              </section>

              {/* List Section */}
              <section>
                {loading ? (
                  <div className="flex justify-center py-12">
                    <Loader2 className="w-8 h-8 text-sky-500/50 animate-spin" />
                  </div>
                ) : (
                  <div className="space-y-3">
                    <AnimatePresence mode="popLayout">
                      {events.length > 0 ? (
                        events.map((event) => (
                          <motion.div
                            key={event.id}
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.95 }}
                            onClick={() => setLongPressedEvent(event)}
                            className={`group bg-zinc-900/30 border border-white/5 hover:border-sky-500/30 p-5 rounded-2xl transition-all flex items-start gap-4 cursor-pointer select-none ${event.completed ? 'opacity-50' : ''}`}
                          >
                            <div className={`mt-1.5 w-2 h-2 rounded-full transition-colors ${event.completed ? 'bg-zinc-600' : 'bg-sky-500/50 group-hover:bg-sky-400'}`} />
                            <div className="flex-1">
                              <p className={`text-zinc-200 leading-relaxed ${event.completed ? 'line-through text-zinc-500' : ''}`}>{event.content}</p>
                            </div>
                          </motion.div>
                        ))
                      ) : (
                        <motion.div
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          className="text-center py-16 bg-zinc-900/20 border border-dashed border-white/5 rounded-3xl"
                        >
                          <p className="text-zinc-600 italic">오늘 등록된 내역이 없습니다.</p>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )}
              </section>
            </motion.div>
          ) : (
            <motion.div
              key="monthly"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.3 }}
            >
              {/* Monthly Header */}
              <header className="mb-12">
                <button 
                  onClick={() => setView('daily')}
                  className="flex items-center gap-2 text-zinc-500 hover:text-sky-400 transition-colors mb-6 group"
                >
                  <ArrowLeft className="w-4 h-4 group-hover:-translate-x-1 transition-transform" />
                  <span className="text-sm font-medium">돌아가기</span>
                </button>
                <div className="flex items-center justify-between">
                  <h1 className="text-2xl font-light tracking-tight text-white">
                    {format(currentMonth, 'yyyy년 M월', { locale: ko })}
                  </h1>
                  <div className="flex items-center gap-2">
                    <button 
                      onClick={() => setCurrentMonth(subMonths(currentMonth, 1))}
                      className="p-2 hover:bg-white/5 rounded-lg transition-colors"
                    >
                      <ChevronLeft className="w-5 h-5 text-zinc-400" />
                    </button>
                    <button 
                      onClick={() => {
                        setCurrentMonth(new Date());
                        setSelectedDate(today);
                      }}
                      className="px-3 py-1 text-xs font-medium bg-zinc-900 border border-white/5 rounded-md hover:bg-zinc-800 transition-colors"
                    >
                      오늘
                    </button>
                    <button 
                      onClick={() => setCurrentMonth(addMonths(currentMonth, 1))}
                      className="p-2 hover:bg-white/5 rounded-lg transition-colors"
                    >
                      <ChevronRight className="w-5 h-5 text-zinc-400" />
                    </button>
                  </div>
                </div>
              </header>

              {/* Calendar Grid */}
              <section className="mb-12">
                {renderCalendar()}
              </section>

              {/* Selected Date Details */}
              {selectedDate && (
                <section className="space-y-6">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <h2 className="text-lg font-medium text-white">
                        {format(new Date(selectedDate), 'M월 d일')} 내역
                      </h2>
                      <span className="text-xs font-mono text-zinc-600 bg-zinc-900 px-2 py-1 rounded border border-white/5">
                        {allEvents.filter(e => e.date === selectedDate).length} entries
                      </span>
                    </div>
                    <button
                      onClick={() => openPopup(selectedDate)}
                      className="flex items-center gap-2 bg-sky-600/20 hover:bg-sky-600/30 text-sky-400 px-4 py-2 rounded-xl text-sm font-medium border border-sky-500/30 transition-all"
                    >
                      <Plus className="w-4 h-4" />
                      <span>추가</span>
                    </button>
                  </div>

                  <div className="space-y-3">
                    {allEvents.filter(e => e.date === selectedDate).length > 0 ? (
                      allEvents.filter(e => e.date === selectedDate).map((event) => (
                        <div
                          key={event.id}
                          onClick={() => setLongPressedEvent(event)}
                          className={`bg-zinc-900/30 border border-white/5 p-4 rounded-2xl flex items-start gap-4 cursor-pointer select-none ${event.completed ? 'opacity-50' : ''}`}
                        >
                          <div className={`mt-1.5 w-1.5 h-1.5 rounded-full ${event.completed ? 'bg-zinc-600' : 'bg-sky-500/50'}`} />
                          <div className="flex-1">
                            <p className={`text-zinc-300 text-sm leading-relaxed ${event.completed ? 'line-through text-zinc-500' : ''}`}>{event.content}</p>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="text-center py-10 bg-zinc-900/10 border border-dashed border-white/5 rounded-2xl">
                        <p className="text-zinc-600 text-sm italic">등록된 내역이 없습니다.</p>
                      </div>
                    )}
                  </div>
                </section>
              )}

            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
